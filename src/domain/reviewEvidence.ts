import { isValidIdentifier } from './task.js';

export const REVIEW_EVIDENCE_CONTENT_REASONS = [
  'content_unavailable',
  'redacted',
  'restricted',
  'access_denied',
  'unsupported_media',
] as const;

export type ReviewEvidenceContentReason =
  (typeof REVIEW_EVIDENCE_CONTENT_REASONS)[number];

export interface ReviewActorV1 {
  readonly kind: 'human';
  readonly id: string;
  readonly issuer: string;
}

export interface ReviewEvidenceReadRequestV1 {
  readonly schema: 'hercules-review-evidence-read/v1';
  readonly taskId: string;
  readonly projectionHash: string;
  readonly artifactRefId: string;
}

export interface ReviewEvidencePortRequestV1 extends ReviewEvidenceReadRequestV1 {
  readonly actor: ReviewActorV1;
  readonly sha256: string;
  readonly redactionState: 'none' | 'redacted' | 'restricted';
  readonly purpose: 'operator_review';
}

export type ReviewEvidencePortResultV1 =
  | {
      readonly status: 'available';
      readonly sha256: string;
      readonly mediaType: string;
      readonly redactionState: 'none' | 'redacted';
      readonly bytes: Uint8Array;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: ReviewEvidenceContentReason;
    };

export type ReviewEvidenceContentV1 =
  | {
      readonly schema: 'hercules-review-evidence-content/v1';
      readonly kind: 'text';
      readonly artifactRefId: string;
      readonly sha256: string;
      readonly mediaType: string;
      readonly redactionState: 'none' | 'redacted';
      readonly text: string;
    }
  | {
      readonly schema: 'hercules-review-evidence-content/v1';
      readonly kind: 'image';
      readonly artifactRefId: string;
      readonly sha256: string;
      readonly mediaType: string;
      readonly redactionState: 'none' | 'redacted';
      readonly authenticatedPath: string;
    }
  | {
      readonly schema: 'hercules-review-evidence-content/v1';
      readonly kind: 'unavailable';
      readonly artifactRefId: string;
      readonly reason: ReviewEvidenceContentReason;
    };

export const REVIEW_EVIDENCE_MAX_TEXT_BYTES = 256 * 1024;
export const REVIEW_EVIDENCE_MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('review evidence value must be an exact object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const own = Object.keys(record);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) {
    throw new TypeError('review evidence value has an invalid schema');
  }
  return record;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !isValidIdentifier(value) ||
    encoder.encode(value).byteLength > 256
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function parseReviewEvidenceReadRequestV1(
  value: unknown,
): Readonly<ReviewEvidenceReadRequestV1> {
  const record = exactRecord(value, [
    'schema',
    'taskId',
    'projectionHash',
    'artifactRefId',
  ]);
  if (record['schema'] !== 'hercules-review-evidence-read/v1') {
    throw new TypeError('review evidence request schema is invalid');
  }
  return Object.freeze({
    schema: 'hercules-review-evidence-read/v1',
    taskId: boundedIdentifier(record['taskId'], 'taskId'),
    projectionHash: digest(record['projectionHash'], 'projectionHash'),
    artifactRefId: boundedIdentifier(record['artifactRefId'], 'artifactRefId'),
  });
}

export function snapshotReviewActorV1(value: unknown): Readonly<ReviewActorV1> {
  const record = exactRecord(value, ['kind', 'id', 'issuer']);
  if (record['kind'] !== 'human') throw new TypeError('review actor kind is invalid');
  return Object.freeze({
    kind: 'human',
    id: boundedIdentifier(record['id'], 'actor id'),
    issuer: boundedIdentifier(record['issuer'], 'actor issuer'),
  });
}

export function snapshotReviewEvidencePortResultV1(
  value: unknown,
): Readonly<ReviewEvidencePortResultV1> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('review evidence result must be an exact object');
  }
  const status = (value as Readonly<Record<string, unknown>>)['status'];
  if (status === 'unavailable') {
    const record = exactRecord(value, ['status', 'reason']);
    if (!(REVIEW_EVIDENCE_CONTENT_REASONS as readonly unknown[]).includes(record['reason'])) {
      throw new TypeError('review evidence unavailable reason is invalid');
    }
    return Object.freeze({
      status: 'unavailable',
      reason: record['reason'] as ReviewEvidenceContentReason,
    });
  }
  if (status !== 'available') throw new TypeError('review evidence status is invalid');
  const record = exactRecord(value, [
    'status',
    'sha256',
    'mediaType',
    'redactionState',
    'bytes',
  ]);
  if (
    typeof record['mediaType'] !== 'string' ||
    record['mediaType'].length === 0 ||
    record['mediaType'].length > 256 ||
    record['mediaType'] !== record['mediaType'].toLowerCase() ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(record['mediaType']) ||
    (record['redactionState'] !== 'none' && record['redactionState'] !== 'redacted') ||
    !(record['bytes'] instanceof Uint8Array) ||
    record['bytes'].byteLength > REVIEW_EVIDENCE_MAX_CONTENT_BYTES
  ) {
    throw new TypeError('review evidence available result is invalid');
  }
  return Object.freeze({
    status: 'available',
    sha256: digest(record['sha256'], 'evidence digest'),
    mediaType: record['mediaType'],
    redactionState: record['redactionState'],
    bytes: Uint8Array.from(record['bytes']),
  });
}
