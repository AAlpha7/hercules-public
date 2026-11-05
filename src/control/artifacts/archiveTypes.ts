import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  ARTIFACT_REDACTION_STATES,
  ARTIFACT_TRUST_CLASSES,
  type ArtifactRef,
  type ArtifactRedactionState,
  type ArtifactTrustClass,
  type CandidateRef,
  type EvidenceEntry,
  type EvidenceManifest,
} from '../../domain/artifact.js';
import { STAGE_TYPES, type StageType } from '../../domain/stageRun.js';

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_TEXT_BYTES = 512;
export const MAX_ARCHIVE_ARRAY_ITEMS = 4_096;
export const MAX_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
export const MAX_CAPTURE_CLOCK_SKEW_MS = 5 * 60_000;

export const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const EXACT_GIT_REVISION_RE = /^[0-9a-f]{40}$/;

export type Sha256Digest = `sha256:${string}`;
export const ARTIFACT_ACCESS_CLASSES = ['operator', 'restricted'] as const;
export type ArtifactAccessClass = (typeof ARTIFACT_ACCESS_CLASSES)[number];
export const ARTIFACT_ACCESS_PURPOSES = ['read', 'verify', 'export', 'operator_review'] as const;
export type ArtifactAccessPurpose = (typeof ARTIFACT_ACCESS_PURPOSES)[number];
export const EVIDENCE_MANIFEST_SCHEMA = 'hercules-evidence-manifest/v1' as const;

export interface ArtifactCaptureAuthorization {
  readonly id: string;
  readonly artifactRefId: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly iterationId: string;
  readonly producerStageRunId: string;
  readonly candidateRef: CandidateRef;
  readonly mediaType: string;
  readonly maximumByteLength: number;
  readonly environmentRef: string;
  readonly surface: string;
  readonly maximumTrustClass: ArtifactTrustClass;
  readonly accessClass: ArtifactAccessClass;
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ArchivedArtifactRef extends ArtifactRef {
  readonly captureAuthorizationId: string;
  readonly captureCandidateRef: CandidateRef;
  readonly accessClass: ArtifactAccessClass;
}

export interface ArchivedEvidenceEntry extends EvidenceEntry {
  readonly redactionState: ArtifactRedactionState;
  readonly accessClass: ArtifactAccessClass;
}

export interface ArchivedEvidenceManifest extends EvidenceManifest {
  readonly schema: typeof EVIDENCE_MANIFEST_SCHEMA;
  readonly entries: readonly ArchivedEvidenceEntry[];
}

export interface ArtifactReadResult {
  readonly artifact: ArchivedArtifactRef;
  readonly bytes: Uint8Array;
}

export interface ArtifactRetirement {
  readonly id: string;
  readonly artifactRefId: string;
  readonly reason: string;
  readonly policyCutoff: string;
  readonly retiredAt: string;
}

export const ARCHIVE_TYPE_ERROR_CODES = [
  'invalid_schema',
  'invalid_identifier',
  'invalid_digest',
  'invalid_timestamp',
  'invalid_media_type',
  'invalid_bounds',
  'invalid_candidate',
  'invalid_capability',
  'expired_capability',
  'capability_mismatch',
] as const;
export type ArchiveTypeErrorCode = (typeof ARCHIVE_TYPE_ERROR_CODES)[number];

export class ArchiveTypeError extends Error {
  override readonly name = 'ArchiveTypeError';

  constructor(
    readonly code: ArchiveTypeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: ArchiveTypeErrorCode, message: string): never {
  throw new ArchiveTypeError(code, message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail('invalid_schema', `${label} must be a plain object`);
  let actual: readonly PropertyKey[];
  try {
    actual = Reflect.ownKeys(value);
  } catch {
    fail('invalid_schema', `${label} schema cannot be inspected`);
  }
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail('invalid_schema', `${label} must use the exact schema`);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('invalid_schema', `${label}.${key} cannot be inspected`);
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid_schema', `${label}.${key} must be an own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function readDenseArrayItem(value: readonly unknown[], index: number, label: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  } catch {
    fail('invalid_schema', `${label}[${index}] cannot be inspected`);
  }
  if (descriptor === undefined || !('value' in descriptor)) {
    fail('invalid_schema', `${label} must contain only own data properties`);
  }
  return descriptor.value;
}

function denseArrayLength(value: readonly unknown[], label: string): number {
  let keys: readonly PropertyKey[];
  let descriptor: PropertyDescriptor | undefined;
  try {
    keys = Reflect.ownKeys(value);
    descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail('invalid_schema', `${label} cannot be inspected`);
  }
  if (descriptor === undefined || !('value' in descriptor) ||
      !Number.isSafeInteger(descriptor.value) || Number(descriptor.value) < 0) {
    fail('invalid_schema', `${label} length is invalid`);
  }
  const length = Number(descriptor.value);
  if (
    keys.length !== length + 1 ||
    !keys.includes('length') ||
    keys.some((key) => key !== 'length' &&
      (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
  ) {
    fail('invalid_schema', `${label} must be an exact dense array`);
  }
  return length;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

export function assertArchiveIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Length(value) > MAX_ARCHIVE_TEXT_BYTES ||
    containsControlCharacter(value)
  ) {
    fail('invalid_identifier', `${label} must be a bounded, control-free identifier`);
  }
}

export function assertSha256Digest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !SHA256_DIGEST_RE.test(value)) {
    fail('invalid_digest', `${label} must be an exact lowercase SHA-256 digest`);
  }
}

export function assertCanonicalUtcTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string') {
    fail('invalid_timestamp', `${label} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('invalid_timestamp', `${label} must be a canonical UTC timestamp`);
  }
}

export function assertArtifactMediaType(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || utf8Length(value) > 256) {
    fail('invalid_media_type', `${label} must be a bounded lower-case media type`);
  }
  const segments = value.split(';');
  const essence = segments[0];
  if (
    essence === undefined ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(
      essence,
    )
  ) {
    fail('invalid_media_type', `${label} must have a lower-case type/subtype`);
  }
  const names = new Set<string>();
  for (let index = 1; index < segments.length; index += 1) {
    const parameter = segments[index];
    if (
      parameter === undefined ||
      !/^ [a-z0-9][a-z0-9!#$&^_.+-]{0,63}=(?:[a-z0-9!#$&^_.+-]+|"[\x20-\x7e]*")$/.test(
        parameter,
      )
    ) {
      fail('invalid_media_type', `${label} contains an unsafe media-type parameter`);
    }
    const name = parameter.slice(1, parameter.indexOf('='));
    if (names.has(name)) {
      fail('invalid_media_type', `${label} contains duplicate parameters`);
    }
    names.add(name);
  }
}

function boundedSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('invalid_bounds', `${label} must be an integer from ${minimum} through ${maximum}`);
  }
}

function copyDenseUniqueIdentifiers(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    fail('invalid_bounds', `${label} must be a non-empty bounded array`);
  }
  const length = denseArrayLength(value, label);
  if (length === 0 || length > MAX_ARCHIVE_ARRAY_ITEMS) {
    fail('invalid_bounds', `${label} must be a non-empty bounded array`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const item = readDenseArrayItem(value, index, label);
    assertArchiveIdentifier(item, `${label}[${index}]`);
    if (seen.has(item)) fail('invalid_schema', `${label} must not contain duplicates`);
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

function copyMediaTypes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    fail('invalid_bounds', `${label} must be a non-empty bounded array`);
  }
  const length = denseArrayLength(value, label);
  if (length === 0 || length > MAX_ARCHIVE_ARRAY_ITEMS) {
    fail('invalid_bounds', `${label} must be a non-empty bounded array`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const item = readDenseArrayItem(value, index, label);
    assertArtifactMediaType(item, `${label}[${index}]`);
    if (seen.has(item)) fail('invalid_schema', `${label} must not contain duplicates`);
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

export function snapshotCandidateRef(value: unknown, label = 'candidateRef'): CandidateRef {
  if (!isPlainRecord(value)) {
    fail('invalid_candidate', `${label} must use a known candidate schema`);
  }
  let kindDescriptor: PropertyDescriptor | undefined;
  try {
    kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  } catch {
    fail('invalid_candidate', `${label}.kind cannot be inspected`);
  }
  if (kindDescriptor === undefined || !('value' in kindDescriptor) || typeof kindDescriptor.value !== 'string') {
    fail('invalid_candidate', `${label}.kind must be an own data property`);
  }
  if (kindDescriptor.value === 'git') {
    const record = readExactRecord(value, ['kind', 'repository', 'revision'], label);
    assertArchiveIdentifier(record['repository'], `${label}.repository`);
    if (typeof record['revision'] !== 'string' || !EXACT_GIT_REVISION_RE.test(record['revision'])) {
      fail('invalid_candidate', `${label}.revision must be an exact lowercase Git commit hash`);
    }
    return Object.freeze({
      kind: 'git',
      repository: record['repository'],
      revision: record['revision'],
    });
  }
  if (kindDescriptor.value === 'artifact') {
    const record = readExactRecord(value, ['kind', 'artifactId', 'sha256'], label);
    assertArchiveIdentifier(record['artifactId'], `${label}.artifactId`);
    assertSha256Digest(record['sha256'], `${label}.sha256`);
    return Object.freeze({
      kind: 'artifact',
      artifactId: record['artifactId'],
      sha256: record['sha256'],
    });
  }
  if (kindDescriptor.value === 'external') {
    const record = readExactRecord(value, ['kind', 'system', 'version', 'digest'], label);
    assertArchiveIdentifier(record['system'], `${label}.system`);
    assertArchiveIdentifier(record['version'], `${label}.version`);
    assertSha256Digest(record['digest'], `${label}.digest`);
    return Object.freeze({
      kind: 'external',
      system: record['system'],
      version: record['version'],
      digest: record['digest'],
    });
  }
  fail('invalid_candidate', `${label} must use a known candidate kind`);
}

function assertAccessClass(value: unknown, label: string): asserts value is ArtifactAccessClass {
  if (!(ARTIFACT_ACCESS_CLASSES as readonly unknown[]).includes(value)) {
    fail('invalid_schema', `${label} must use a closed access class`);
  }
}

function assertTrustClass(value: unknown, label: string): asserts value is ArtifactTrustClass {
  if (!(ARTIFACT_TRUST_CLASSES as readonly unknown[]).includes(value)) {
    fail('invalid_schema', `${label} must use a closed trust class`);
  }
}

function assertRedactionState(
  value: unknown,
  label: string,
): asserts value is ArtifactRedactionState {
  if (!(ARTIFACT_REDACTION_STATES as readonly unknown[]).includes(value)) {
    fail('invalid_schema', `${label} must use a closed redaction state`);
  }
}

function timestampMilliseconds(value: string): number {
  return Date.parse(value);
}

function assertLiveWindow(issuedAt: string, expiresAt: string, now: string, label: string): void {
  assertCanonicalUtcTimestamp(now, 'now');
  if (
    timestampMilliseconds(issuedAt) > timestampMilliseconds(expiresAt) ||
    timestampMilliseconds(now) < timestampMilliseconds(issuedAt) ||
    timestampMilliseconds(now) > timestampMilliseconds(expiresAt)
  ) {
    fail('expired_capability', `${label} is not live at the supplied archive time`);
  }
}

declare const archiveAuthorityBrand: unique symbol;
declare const artifactObservationBrand: unique symbol;
declare const artifactAccessBrand: unique symbol;

export interface ArchiveAuthorityContext {
  readonly [archiveAuthorityBrand]: true;
}

export interface ArtifactCaptureObservation {
  readonly [artifactObservationBrand]: true;
}

export interface ArtifactAccessContext {
  readonly [artifactAccessBrand]: true;
}

declare const artifactArchiveAdmissionBrand: unique symbol;

export interface ArtifactArchiveAdmissionToken {
  readonly [artifactArchiveAdmissionBrand]: true;
}

export interface ArtifactArchiveAdmissionGate {
  enter(): ArtifactArchiveAdmissionToken;
  assertOwns(token: unknown): asserts token is ArtifactArchiveAdmissionToken;
  leave(token: ArtifactArchiveAdmissionToken): void;
}

const admissionOwners = new WeakMap<object, ArtifactArchiveAdmissionGateImpl>();
const admissionGates = new WeakSet<object>();

class ArtifactArchiveAdmissionGateImpl implements ArtifactArchiveAdmissionGate {
  #active: ArtifactArchiveAdmissionToken | null = null;

  constructor() {
    admissionGates.add(this);
  }

  enter(): ArtifactArchiveAdmissionToken {
    if (this.#active !== null) fail('invalid_capability', 'artifact archive operation gate is busy');
    const token = Object.freeze(Object.create(null) as object) as ArtifactArchiveAdmissionToken;
    admissionOwners.set(token, this);
    this.#active = token;
    return token;
  }

  assertOwns(token: unknown): asserts token is ArtifactArchiveAdmissionToken {
    if (
      token === null ||
      typeof token !== 'object' ||
      this.#active !== token ||
      admissionOwners.get(token) !== this
    ) {
      fail('invalid_capability', 'artifact archive admission token is forged or inactive');
    }
  }

  leave(token: ArtifactArchiveAdmissionToken): void {
    this.assertOwns(token);
    admissionOwners.delete(token as object);
    this.#active = null;
  }
}

/** Construction is structurally restricted to evidenceArchive and tests. */
export function createArtifactArchiveAdmissionGate(): ArtifactArchiveAdmissionGate {
  return new ArtifactArchiveAdmissionGateImpl();
}

export function assertArtifactArchiveAdmissionGate(
  value: unknown,
): asserts value is ArtifactArchiveAdmissionGate {
  if (value === null || typeof value !== 'object' || !admissionGates.has(value)) {
    fail('invalid_capability', 'artifact archive admission gate is forged');
  }
}

export interface ArchiveAuthorityFacts {
  readonly issuer: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly iterationId: string;
  readonly producerStageRunId: string;
  readonly stageType: StageType;
  readonly stageStartedAt: string;
  readonly candidateRef: CandidateRef;
  readonly environmentRef: string;
  readonly surface: string;
  readonly maximumTrustClass: ArtifactTrustClass;
  readonly maximumAccessClass: ArtifactAccessClass;
  readonly maximumByteLength: number;
  readonly allowedMediaTypes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ArtifactCaptureObservationFacts {
  readonly authorizationId: string;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly redactionState: ArtifactRedactionState;
  readonly accessClass: ArtifactAccessClass;
  readonly observedAt: string;
}

export interface ArtifactAccessFacts {
  readonly sha256: Sha256Digest;
  readonly purpose: ArtifactAccessPurpose;
  readonly authorizationClass: ArtifactAccessClass;
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const authorityFacts = new WeakMap<object, Readonly<ArchiveAuthorityFacts>>();
const observationFacts = new WeakMap<object, Readonly<ArtifactCaptureObservationFacts>>();
const accessFacts = new WeakMap<object, Readonly<ArtifactAccessFacts>>();

function opaqueCapability<T extends object>(): T {
  const capability = Object.create(null) as object;
  Object.defineProperty(capability, 'toJSON', {
    configurable: false,
    enumerable: false,
    value: () => fail('invalid_capability', 'opaque archive capabilities cannot be serialized'),
    writable: false,
  });
  return Object.freeze(capability) as T;
}

function mintArchiveAuthorityContextInternal(value: unknown): ArchiveAuthorityContext {
  const record = readExactRecord(value, [
    'issuer',
    'taskId',
    'contractVersion',
    'iterationId',
    'producerStageRunId',
    'stageType',
    'stageStartedAt',
    'candidateRef',
    'environmentRef',
    'surface',
    'maximumTrustClass',
    'maximumAccessClass',
    'maximumByteLength',
    'allowedMediaTypes',
    'issuedAt',
    'expiresAt',
  ], 'archive authority facts');
  const issuer = record['issuer'];
  const taskId = record['taskId'];
  const iterationId = record['iterationId'];
  const producerStageRunId = record['producerStageRunId'];
  const environmentRef = record['environmentRef'];
  const surface = record['surface'];
  assertArchiveIdentifier(issuer, 'archive authority issuer');
  assertArchiveIdentifier(taskId, 'archive authority taskId');
  assertArchiveIdentifier(iterationId, 'archive authority iterationId');
  assertArchiveIdentifier(producerStageRunId, 'archive authority producerStageRunId');
  assertArchiveIdentifier(environmentRef, 'archive authority environmentRef');
  assertArchiveIdentifier(surface, 'archive authority surface');
  boundedSafeInteger(record['contractVersion'], 1, Number.MAX_SAFE_INTEGER, 'contractVersion');
  if (!(STAGE_TYPES as readonly unknown[]).includes(record['stageType'])) {
    fail('invalid_schema', 'archive authority stageType is invalid');
  }
  assertCanonicalUtcTimestamp(record['stageStartedAt'], 'stageStartedAt');
  assertTrustClass(record['maximumTrustClass'], 'maximumTrustClass');
  assertAccessClass(record['maximumAccessClass'], 'maximumAccessClass');
  boundedSafeInteger(record['maximumByteLength'], 0, MAX_ARTIFACT_BYTES, 'maximumByteLength');
  assertCanonicalUtcTimestamp(record['issuedAt'], 'issuedAt');
  assertCanonicalUtcTimestamp(record['expiresAt'], 'expiresAt');
  if (timestampMilliseconds(record['stageStartedAt']) > timestampMilliseconds(record['issuedAt'])) {
    fail('invalid_timestamp', 'stageStartedAt cannot be later than issuedAt');
  }
  if (timestampMilliseconds(record['issuedAt']) > timestampMilliseconds(record['expiresAt'])) {
    fail('invalid_timestamp', 'issuedAt cannot be later than expiresAt');
  }
  if (record['maximumTrustClass'] === 'primary' && record['stageType'] !== 'verify') {
    fail('invalid_capability', 'only a verify stage may authorize primary evidence');
  }
  const facts: Readonly<ArchiveAuthorityFacts> = Object.freeze({
    issuer,
    taskId,
    contractVersion: record['contractVersion'],
    iterationId,
    producerStageRunId,
    stageType: record['stageType'] as StageType,
    stageStartedAt: record['stageStartedAt'],
    candidateRef: snapshotCandidateRef(record['candidateRef']),
    environmentRef,
    surface,
    maximumTrustClass: record['maximumTrustClass'],
    maximumAccessClass: record['maximumAccessClass'],
    maximumByteLength: record['maximumByteLength'],
    allowedMediaTypes: copyMediaTypes(record['allowedMediaTypes'], 'allowedMediaTypes'),
    issuedAt: record['issuedAt'],
    expiresAt: record['expiresAt'],
  });
  const capability = opaqueCapability<ArchiveAuthorityContext>();
  authorityFacts.set(capability, facts);
  return capability;
}

export function snapshotArchiveAuthorityContext(
  value: unknown,
  now: string,
): Readonly<ArchiveAuthorityFacts> {
  if (value === null || typeof value !== 'object') {
    fail('invalid_capability', 'archive authority must be an opaque capability');
  }
  const facts = authorityFacts.get(value);
  if (facts === undefined) fail('invalid_capability', 'archive authority capability is forged');
  assertLiveWindow(facts.issuedAt, facts.expiresAt, now, 'archive authority');
  return facts;
}

function mintArtifactCaptureObservationInternal(value: unknown): ArtifactCaptureObservation {
  const facts = snapshotObservationFacts(value);
  const capability = opaqueCapability<ArtifactCaptureObservation>();
  observationFacts.set(capability, facts);
  return capability;
}

function snapshotObservationFacts(value: unknown): Readonly<ArtifactCaptureObservationFacts> {
  const record = readExactRecord(value, [
    'authorizationId',
    'sha256',
    'byteLength',
    'redactionState',
    'accessClass',
    'observedAt',
  ], 'artifact capture observation');
  assertArchiveIdentifier(record['authorizationId'], 'authorizationId');
  assertSha256Digest(record['sha256'], 'sha256');
  boundedSafeInteger(record['byteLength'], 0, MAX_ARTIFACT_BYTES, 'byteLength');
  assertRedactionState(record['redactionState'], 'redactionState');
  assertAccessClass(record['accessClass'], 'accessClass');
  assertCanonicalUtcTimestamp(record['observedAt'], 'observedAt');
  if (record['redactionState'] === 'restricted' && record['accessClass'] !== 'restricted') {
    fail('invalid_capability', 'restricted redaction requires restricted access');
  }
  return Object.freeze({
    authorizationId: record['authorizationId'],
    sha256: record['sha256'],
    byteLength: record['byteLength'],
    redactionState: record['redactionState'],
    accessClass: record['accessClass'],
    observedAt: record['observedAt'],
  });
}

export function snapshotArtifactCaptureObservation(
  value: unknown,
  expected: Readonly<{
    authorizationId: string;
    sha256: string;
    byteLength: number;
    stageStartedAt: string;
    capturedAt: string;
    clockSkewMs: number;
  }>,
): Readonly<ArtifactCaptureObservationFacts> {
  if (value === null || typeof value !== 'object') {
    fail('invalid_capability', 'artifact observation must be an opaque capability');
  }
  const facts = observationFacts.get(value);
  if (facts === undefined) fail('invalid_capability', 'artifact observation capability is forged');
  assertCanonicalUtcTimestamp(expected.stageStartedAt, 'stageStartedAt');
  assertCanonicalUtcTimestamp(expected.capturedAt, 'capturedAt');
  boundedSafeInteger(expected.clockSkewMs, 0, MAX_CAPTURE_CLOCK_SKEW_MS, 'clockSkewMs');
  if (
    facts.authorizationId !== expected.authorizationId ||
    facts.sha256 !== expected.sha256 ||
    facts.byteLength !== expected.byteLength
  ) {
    fail('capability_mismatch', 'artifact observation does not bind the captured content');
  }
  const observed = timestampMilliseconds(facts.observedAt);
  if (
    observed < timestampMilliseconds(expected.stageStartedAt) ||
    observed > timestampMilliseconds(expected.capturedAt)
  ) {
    fail('capability_mismatch', 'artifact observation lies outside the permitted capture window');
  }
  return facts;
}

function mintArtifactAccessContextInternal(value: unknown): ArtifactAccessContext {
  const record = readExactRecord(value, [
    'sha256',
    'purpose',
    'authorizationClass',
    'issuer',
    'issuedAt',
    'expiresAt',
  ], 'artifact access facts');
  assertSha256Digest(record['sha256'], 'sha256');
  if (!(ARTIFACT_ACCESS_PURPOSES as readonly unknown[]).includes(record['purpose'])) {
    fail('invalid_schema', 'artifact access purpose is invalid');
  }
  assertAccessClass(record['authorizationClass'], 'authorizationClass');
  assertArchiveIdentifier(record['issuer'], 'issuer');
  assertCanonicalUtcTimestamp(record['issuedAt'], 'issuedAt');
  assertCanonicalUtcTimestamp(record['expiresAt'], 'expiresAt');
  if (timestampMilliseconds(record['issuedAt']) > timestampMilliseconds(record['expiresAt'])) {
    fail('invalid_timestamp', 'issuedAt cannot be later than expiresAt');
  }
  const facts: Readonly<ArtifactAccessFacts> = Object.freeze({
    sha256: record['sha256'],
    purpose: record['purpose'] as ArtifactAccessPurpose,
    authorizationClass: record['authorizationClass'],
    issuer: record['issuer'],
    issuedAt: record['issuedAt'],
    expiresAt: record['expiresAt'],
  });
  const capability = opaqueCapability<ArtifactAccessContext>();
  accessFacts.set(capability, facts);
  return capability;
}

export interface ArtifactCapabilityIssuer {
  issueArchiveAuthority(value: unknown): ArchiveAuthorityContext;
  issueCaptureObservation(value: unknown): ArtifactCaptureObservation;
  issueArtifactAccess(value: unknown): ArtifactAccessContext;
}

function createArtifactCapabilityIssuer(): Readonly<ArtifactCapabilityIssuer> {
  return Object.freeze({
    issueArchiveAuthority: mintArchiveAuthorityContextInternal,
    issueCaptureObservation: mintArtifactCaptureObservationInternal,
    issueArtifactAccess: mintArtifactAccessContextInternal,
  });
}

/** Test-only facade. A structural invariant forbids every production caller. */
export const TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER: Readonly<ArtifactCapabilityIssuer> =
  createArtifactCapabilityIssuer();

/**
 * Composition-root issuer. The only production mint path for opaque archive
 * capabilities; named exclusively from `src/main.ts` (fenced). The returned
 * issuer mints nothing without valid facts — `snapshot*` validates at use time.
 */
export function openArchiveCapabilityIssuerForComposition(
  binding: { readonly issuer: string },
): Readonly<ArtifactCapabilityIssuer> {
  assertArchiveIdentifier(binding.issuer, 'composition capability issuer');
  return createArtifactCapabilityIssuer();
}

export function snapshotArtifactAccessContext(
  value: unknown,
  expectedDigest: string,
  now: string,
): Readonly<ArtifactAccessFacts> {
  assertSha256Digest(expectedDigest, 'expectedDigest');
  if (value === null || typeof value !== 'object') {
    fail('invalid_capability', 'artifact access must be an opaque capability');
  }
  const facts = accessFacts.get(value);
  if (facts === undefined) fail('invalid_capability', 'artifact access capability is forged');
  assertLiveWindow(facts.issuedAt, facts.expiresAt, now, 'artifact access');
  if (facts.sha256 !== expectedDigest) {
    fail('capability_mismatch', 'artifact access does not bind the requested digest');
  }
  return facts;
}

export function assertArtifactAccessContextCapability(
  value: unknown,
): asserts value is ArtifactAccessContext {
  if (value === null || typeof value !== 'object' || !accessFacts.has(value)) {
    fail('invalid_capability', 'artifact access capability is forged');
  }
}

export interface ArtifactArchivePolicy {
  readonly maximumArtifactBytes: number;
  readonly lockAcquireTimeoutMs: number;
  readonly clockSkewMs: number;
  readonly maximumCommandEntries: number;
  readonly maximumManifestCriteria: number;
  readonly inventoryPageSize: number;
  readonly retentionDays: number | null;
  readonly orphanGraceDays: number;
}

export interface ArtifactEvidenceArchiveOptions {
  readonly artifactRoot: string;
  readonly databasePath: string;
  readonly databaseTrustedRoot: string;
  readonly exportRoot: string;
  readonly controlRepositoryRoot: string;
  readonly providerWorkRoots: readonly string[];
  readonly policy: ArtifactArchivePolicy;
  readonly clock: () => string;
}

export interface ArtifactEvidenceArchiveOptionsSnapshot extends ArtifactEvidenceArchiveOptions {
  readonly providerWorkRoots: readonly string[];
  readonly policy: Readonly<ArtifactArchivePolicy>;
}

function snapshotAbsolutePath(value: unknown, label: string): string {
  assertArchiveIdentifier(value, label);
  if (!isAbsolute(value) || resolve(value) !== value) {
    fail('invalid_schema', `${label} must be an absolute normalized path`);
  }
  return value;
}

function snapshotProviderRoots(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    fail('invalid_bounds', 'providerWorkRoots must be a bounded array');
  }
  const length = denseArrayLength(value, 'providerWorkRoots');
  if (length > MAX_ARCHIVE_ARRAY_ITEMS) fail('invalid_bounds', 'providerWorkRoots must be a bounded array');
  const roots: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const root = snapshotAbsolutePath(
      readDenseArrayItem(value, index, 'providerWorkRoots'),
      `providerWorkRoots[${index}]`,
    );
    if (seen.has(root)) fail('invalid_schema', 'providerWorkRoots must be unique');
    seen.add(root);
    roots.push(root);
  }
  roots.sort(compareCodeUnits);
  return Object.freeze(roots);
}

function assertPairwiseNonOverlappingRoots(paths: readonly string[]): void {
  const roots = new Set<string>();
  for (const path of paths) {
    if (roots.has(path)) fail('invalid_schema', 'archive configured roots must be distinct');
    roots.add(path);
  }
  for (const path of roots) {
    let cursor = dirname(path);
    while (cursor !== dirname(cursor)) {
      if (roots.has(cursor)) {
        fail('invalid_schema', 'archive configured roots must not overlap');
      }
      cursor = dirname(cursor);
    }
    if (roots.has(cursor)) fail('invalid_schema', 'archive configured roots must not overlap');
  }
}

export function snapshotArtifactEvidenceArchiveOptions(
  value: unknown,
): Readonly<ArtifactEvidenceArchiveOptionsSnapshot> {
  const record = readExactRecord(
    value,
    [
      'artifactRoot',
      'databasePath',
      'databaseTrustedRoot',
      'exportRoot',
      'controlRepositoryRoot',
      'providerWorkRoots',
      'policy',
      'clock',
    ],
    'artifact archive options',
  );
  const artifactRoot = snapshotAbsolutePath(record['artifactRoot'], 'artifactRoot');
  const databasePath = snapshotAbsolutePath(record['databasePath'], 'databasePath');
  const databaseTrustedRoot = snapshotAbsolutePath(
    record['databaseTrustedRoot'],
    'databaseTrustedRoot',
  );
  const exportRoot = snapshotAbsolutePath(record['exportRoot'], 'exportRoot');
  const controlRepositoryRoot = snapshotAbsolutePath(
    record['controlRepositoryRoot'],
    'controlRepositoryRoot',
  );
  const providerWorkRoots = snapshotProviderRoots(record['providerWorkRoots']);
  if (dirname(databasePath) !== databaseTrustedRoot) {
    fail('invalid_schema', 'databasePath must be an immediate child of databaseTrustedRoot');
  }
  assertPairwiseNonOverlappingRoots([
    artifactRoot,
    exportRoot,
    databaseTrustedRoot,
    controlRepositoryRoot,
    ...providerWorkRoots,
  ]);
  const policy = readExactRecord(record['policy'], [
    'maximumArtifactBytes',
    'lockAcquireTimeoutMs',
    'clockSkewMs',
    'maximumCommandEntries',
    'maximumManifestCriteria',
    'inventoryPageSize',
    'retentionDays',
    'orphanGraceDays',
  ], 'artifact archive policy');
  boundedSafeInteger(policy['maximumArtifactBytes'], 1, MAX_ARTIFACT_BYTES, 'maximumArtifactBytes');
  boundedSafeInteger(policy['lockAcquireTimeoutMs'], 1, MAX_LOCK_ACQUIRE_TIMEOUT_MS, 'lockAcquireTimeoutMs');
  boundedSafeInteger(policy['clockSkewMs'], 0, MAX_CAPTURE_CLOCK_SKEW_MS, 'clockSkewMs');
  boundedSafeInteger(policy['maximumCommandEntries'], 1, MAX_ARCHIVE_ARRAY_ITEMS, 'maximumCommandEntries');
  boundedSafeInteger(policy['maximumManifestCriteria'], 1, MAX_ARCHIVE_ARRAY_ITEMS, 'maximumManifestCriteria');
  boundedSafeInteger(policy['inventoryPageSize'], 1, MAX_ARCHIVE_ARRAY_ITEMS, 'inventoryPageSize');
  if (policy['retentionDays'] !== null) {
    boundedSafeInteger(policy['retentionDays'], 1, Number.MAX_SAFE_INTEGER, 'retentionDays');
  }
  boundedSafeInteger(policy['orphanGraceDays'], 1, Number.MAX_SAFE_INTEGER, 'orphanGraceDays');
  if (typeof record['clock'] !== 'function') {
    fail('invalid_schema', 'archive clock must be a trusted callback');
  }
  return Object.freeze({
    artifactRoot,
    databasePath,
    databaseTrustedRoot,
    exportRoot,
    controlRepositoryRoot,
    providerWorkRoots,
    policy: Object.freeze({
      maximumArtifactBytes: policy['maximumArtifactBytes'],
      lockAcquireTimeoutMs: policy['lockAcquireTimeoutMs'],
      clockSkewMs: policy['clockSkewMs'],
      maximumCommandEntries: policy['maximumCommandEntries'],
      maximumManifestCriteria: policy['maximumManifestCriteria'],
      inventoryPageSize: policy['inventoryPageSize'],
      retentionDays: policy['retentionDays'],
      orphanGraceDays: policy['orphanGraceDays'],
    }),
    clock: record['clock'] as () => string,
  });
}

export interface IssueArtifactCaptureAuthorizationRequest {
  readonly id: string;
  readonly artifactRefId: string;
  readonly idempotencyKey: string;
  readonly mediaType: string;
  readonly maximumByteLength: number;
  readonly accessClass: ArtifactAccessClass;
}

export function snapshotIssueArtifactCaptureAuthorizationRequest(
  value: unknown,
): Readonly<IssueArtifactCaptureAuthorizationRequest> {
  const record = readExactRecord(value, [
    'id',
    'artifactRefId',
    'idempotencyKey',
    'mediaType',
    'maximumByteLength',
    'accessClass',
  ], 'capture authorization request');
  const id = record['id'];
  const artifactRefId = record['artifactRefId'];
  const idempotencyKey = record['idempotencyKey'];
  assertArchiveIdentifier(id, 'id');
  assertArchiveIdentifier(artifactRefId, 'artifactRefId');
  assertArchiveIdentifier(idempotencyKey, 'idempotencyKey');
  assertArtifactMediaType(record['mediaType'], 'mediaType');
  boundedSafeInteger(record['maximumByteLength'], 0, MAX_ARTIFACT_BYTES, 'maximumByteLength');
  assertAccessClass(record['accessClass'], 'accessClass');
  return Object.freeze({
    id,
    artifactRefId,
    idempotencyKey,
    mediaType: record['mediaType'],
    maximumByteLength: record['maximumByteLength'],
    accessClass: record['accessClass'],
  });
}

export function deriveArtifactCaptureAuthorization(
  requestValue: unknown,
  authorityValue: unknown,
  now: string,
): Readonly<ArtifactCaptureAuthorization> {
  const request = snapshotIssueArtifactCaptureAuthorizationRequest(requestValue);
  const authority = snapshotArchiveAuthorityContext(authorityValue, now);
  if (!authority.allowedMediaTypes.includes(request.mediaType)) {
    fail('capability_mismatch', 'requested media type is outside the authority grant');
  }
  if (request.maximumByteLength > authority.maximumByteLength) {
    fail('capability_mismatch', 'requested byte limit exceeds the authority grant');
  }
  if (
    authority.maximumAccessClass === 'restricted' &&
    request.accessClass !== 'restricted'
  ) {
    fail('capability_mismatch', 'requested access class weakens the authority restriction');
  }
  return Object.freeze({
    id: request.id,
    artifactRefId: request.artifactRefId,
    taskId: authority.taskId,
    contractVersion: authority.contractVersion,
    iterationId: authority.iterationId,
    producerStageRunId: authority.producerStageRunId,
    candidateRef: authority.candidateRef,
    mediaType: request.mediaType,
    maximumByteLength: request.maximumByteLength,
    environmentRef: authority.environmentRef,
    surface: authority.surface,
    maximumTrustClass: authority.maximumTrustClass,
    accessClass: request.accessClass,
    issuer: authority.issuer,
    issuedAt: authority.issuedAt,
    expiresAt: authority.expiresAt,
  });
}

export interface RecordArtifactCommand {
  readonly authorizationId: string;
  readonly observation: ArtifactCaptureObservation;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface RecordArtifactCommandSnapshot {
  readonly authorizationId: string;
  readonly observation: Readonly<ArtifactCaptureObservationFacts>;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
}

export interface RecordArtifactInputSnapshot {
  readonly authorizationId: string;
  readonly observation: ArtifactCaptureObservation;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
}

function copyArtifactBytes(value: unknown, maximumBytes: number): Uint8Array {
  boundedSafeInteger(maximumBytes, 1, MAX_ARTIFACT_BYTES, 'maximumBytes');
  if (!(value instanceof Uint8Array)) {
    fail('invalid_schema', 'artifact bytes must be a Uint8Array');
  }
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
  const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
  if (byteLengthGetter === undefined || bufferGetter === undefined) {
    fail('invalid_schema', 'typed-array intrinsics are unavailable');
  }
  let byteLength: number;
  let buffer: ArrayBufferLike;
  try {
    byteLength = byteLengthGetter.call(value) as number;
    buffer = bufferGetter.call(value) as ArrayBufferLike;
  } catch {
    fail('invalid_schema', 'artifact bytes must be a genuine Uint8Array');
  }
  if (
    typeof SharedArrayBuffer !== 'undefined' &&
    buffer instanceof SharedArrayBuffer
  ) {
    fail('invalid_schema', 'artifact bytes cannot be backed by SharedArrayBuffer');
  }
  if (byteLength > maximumBytes) {
    fail('invalid_bounds', `artifact bytes exceed the ${maximumBytes} byte limit`);
  }
  const copy = new Uint8Array(byteLength);
  try {
    Uint8Array.prototype.set.call(copy, value);
  } catch {
    fail('invalid_schema', 'artifact bytes could not be copied safely');
  }
  if (copy.byteLength !== byteLength) fail('invalid_schema', 'artifact byte copy changed size');
  return copy;
}

export function snapshotRecordArtifactCommand(
  value: unknown,
  policy: Readonly<Pick<ArtifactArchivePolicy, 'maximumArtifactBytes' | 'clockSkewMs'>>,
  capture: Readonly<{ stageStartedAt: string; capturedAt: string }>,
): Readonly<RecordArtifactCommandSnapshot> {
  const input = snapshotRecordArtifactInput(value, policy.maximumArtifactBytes);
  return bindRecordArtifactObservation(input, policy, capture);
}

export function snapshotRecordArtifactInput(
  value: unknown,
  maximumArtifactBytes: number,
): Readonly<RecordArtifactInputSnapshot> {
  const record = readExactRecord(
    value,
    ['authorizationId', 'observation', 'mediaType', 'bytes'],
    'record artifact command',
  );
  assertArchiveIdentifier(record['authorizationId'], 'authorizationId');
  assertArtifactMediaType(record['mediaType'], 'mediaType');
  boundedSafeInteger(maximumArtifactBytes, 1, MAX_ARTIFACT_BYTES, 'maximumArtifactBytes');
  const bytes = copyArtifactBytes(record['bytes'], maximumArtifactBytes);
  if (
    record['observation'] === null ||
    typeof record['observation'] !== 'object' ||
    !observationFacts.has(record['observation'])
  ) {
    fail('invalid_capability', 'artifact observation capability is forged');
  }
  return Object.freeze({
    authorizationId: record['authorizationId'],
    observation: record['observation'] as ArtifactCaptureObservation,
    mediaType: record['mediaType'],
    bytes,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Sha256Digest,
    byteLength: bytes.byteLength,
  });
}

export function bindRecordArtifactObservation(
  input: Readonly<RecordArtifactInputSnapshot>,
  policy: Readonly<Pick<ArtifactArchivePolicy, 'maximumArtifactBytes' | 'clockSkewMs'>>,
  capture: Readonly<{ stageStartedAt: string; capturedAt: string }>,
): Readonly<RecordArtifactCommandSnapshot> {
  const policySnapshot = readExactRecord(
    policy,
    ['maximumArtifactBytes', 'clockSkewMs'],
    'record artifact policy',
  );
  const captureSnapshot = readExactRecord(
    capture,
    ['stageStartedAt', 'capturedAt'],
    'record artifact capture facts',
  );
  boundedSafeInteger(policySnapshot['maximumArtifactBytes'], 1, MAX_ARTIFACT_BYTES, 'maximumArtifactBytes');
  boundedSafeInteger(policySnapshot['clockSkewMs'], 0, MAX_CAPTURE_CLOCK_SKEW_MS, 'clockSkewMs');
  assertCanonicalUtcTimestamp(captureSnapshot['stageStartedAt'], 'stageStartedAt');
  assertCanonicalUtcTimestamp(captureSnapshot['capturedAt'], 'capturedAt');
  if (input.byteLength > policySnapshot['maximumArtifactBytes']) {
    fail('invalid_bounds', 'artifact input exceeds the configured byte limit');
  }
  const observation = snapshotArtifactCaptureObservation(input.observation, {
    authorizationId: input.authorizationId,
    sha256: input.sha256,
    byteLength: input.byteLength,
    stageStartedAt: captureSnapshot['stageStartedAt'],
    capturedAt: captureSnapshot['capturedAt'],
    clockSkewMs: policySnapshot['clockSkewMs'],
  });
  return Object.freeze({
    authorizationId: input.authorizationId,
    observation,
    mediaType: input.mediaType,
    bytes: input.bytes,
    sha256: input.sha256,
    byteLength: input.byteLength,
  });
}

export interface EvidenceManifestEntryRequest {
  readonly artifactRefId: string;
  readonly criterionIds: readonly string[];
}

export interface RecordEvidenceManifestCommand {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly iterationId: string;
  readonly entries: readonly EvidenceManifestEntryRequest[];
}

export function snapshotRecordEvidenceManifestCommand(
  value: unknown,
  maximumEntries = MAX_ARCHIVE_ARRAY_ITEMS,
  maximumCriteria = MAX_ARCHIVE_ARRAY_ITEMS,
): Readonly<RecordEvidenceManifestCommand> {
  boundedSafeInteger(maximumEntries, 1, MAX_ARCHIVE_ARRAY_ITEMS, 'maximumEntries');
  boundedSafeInteger(maximumCriteria, 1, MAX_ARCHIVE_ARRAY_ITEMS, 'maximumCriteria');
  const record = readExactRecord(value, [
    'id',
    'idempotencyKey',
    'taskId',
    'contractVersion',
    'iterationId',
    'entries',
  ], 'record evidence manifest command');
  const id = record['id'];
  const idempotencyKey = record['idempotencyKey'];
  const taskId = record['taskId'];
  const iterationId = record['iterationId'];
  assertArchiveIdentifier(id, 'id');
  assertArchiveIdentifier(idempotencyKey, 'idempotencyKey');
  assertArchiveIdentifier(taskId, 'taskId');
  assertArchiveIdentifier(iterationId, 'iterationId');
  boundedSafeInteger(record['contractVersion'], 1, Number.MAX_SAFE_INTEGER, 'contractVersion');
  if (!Array.isArray(record['entries'])) {
    fail('invalid_bounds', 'manifest entries must be a non-empty bounded array');
  }
  const entryCount = denseArrayLength(record['entries'], 'manifest entries');
  if (entryCount === 0 || entryCount > maximumEntries) {
    fail('invalid_bounds', 'manifest entries must be a non-empty bounded array');
  }
  const entries: EvidenceManifestEntryRequest[] = [];
  const artifactIds = new Set<string>();
  let criterionCount = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = readExactRecord(
      readDenseArrayItem(record['entries'], index, 'manifest entries'),
      ['artifactRefId', 'criterionIds'],
      `manifest entries[${index}]`,
    );
    assertArchiveIdentifier(entry['artifactRefId'], `manifest entries[${index}].artifactRefId`);
    if (artifactIds.has(entry['artifactRefId'])) {
      fail('invalid_schema', 'manifest artifact references must be unique');
    }
    artifactIds.add(entry['artifactRefId']);
    const criterionIds = Object.freeze(
      copyDenseUniqueIdentifiers(
        entry['criterionIds'],
        `manifest entries[${index}].criterionIds`,
      ).slice().sort(compareCodeUnits),
    );
    criterionCount += criterionIds.length;
    if (criterionCount > maximumCriteria) {
      fail('invalid_bounds', 'manifest criteria exceed the total configured bound');
    }
    entries.push(Object.freeze({
      artifactRefId: entry['artifactRefId'],
      criterionIds,
    }));
  }
  entries.sort((left, right) => compareCodeUnits(left.artifactRefId, right.artifactRefId));
  return Object.freeze({
    id,
    idempotencyKey,
    taskId,
    contractVersion: record['contractVersion'],
    iterationId,
    entries: Object.freeze(entries),
  });
}

export interface RetireArtifactCommand {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly artifactRefId: string;
  readonly reason: string;
  readonly policyCutoff: string;
}

export function snapshotRetireArtifactCommand(
  value: unknown,
): Readonly<RetireArtifactCommand> {
  const record = readExactRecord(value, [
    'id',
    'idempotencyKey',
    'artifactRefId',
    'reason',
    'policyCutoff',
  ], 'retire artifact command');
  const id = record['id'];
  const idempotencyKey = record['idempotencyKey'];
  const artifactRefId = record['artifactRefId'];
  const reason = record['reason'];
  assertArchiveIdentifier(id, 'id');
  assertArchiveIdentifier(idempotencyKey, 'idempotencyKey');
  assertArchiveIdentifier(artifactRefId, 'artifactRefId');
  assertArchiveIdentifier(reason, 'reason');
  assertCanonicalUtcTimestamp(record['policyCutoff'], 'policyCutoff');
  return Object.freeze({
    id,
    idempotencyKey,
    artifactRefId,
    reason,
    policyCutoff: record['policyCutoff'],
  });
}
