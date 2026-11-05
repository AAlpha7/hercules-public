import { ReviewDtoDecodeError, type EvidenceSummaryDto } from './reviewTypes.js';

export type ReviewEvidenceContentDto =
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
      readonly reason:
        | 'content_unavailable'
        | 'redacted'
        | 'restricted'
        | 'access_denied'
        | 'unsupported_media';
    };

const encoder = new TextEncoder();
const CONTENT_REASONS = [
  'content_unavailable', 'redacted', 'restricted', 'access_denied', 'unsupported_media',
] as const;

function reject(message: string): never {
  throw new ReviewDtoDecodeError(message);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return reject('review evidence content must be an exact object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const own = Object.keys(record);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) {
    return reject('review evidence content has an invalid schema');
  }
  return record;
}

function safeAuthenticatedPath(value: unknown, expectedPath: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/api/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) return reject('review evidence image path is invalid');
  const parsed = new URL(value, 'https://hercules.invalid');
  if (
    parsed.origin !== 'https://hercules.invalid' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== expectedPath
  ) return reject('review evidence image path is invalid');
  return value;
}

export function decodeReviewEvidenceContentV1(
  value: unknown,
  expected: Readonly<{
    evidence: EvidenceSummaryDto;
    taskId: string;
    projectionHash: string;
  }>,
): ReviewEvidenceContentDto {
  const evidence = expected.evidence;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return reject('review evidence content must be an exact object');
  }
  const kind = (value as Readonly<Record<string, unknown>>)['kind'];
  if (kind === 'unavailable') {
    const record = exactRecord(value, ['schema', 'kind', 'artifactRefId', 'reason']);
    if (
      record['schema'] !== 'hercules-review-evidence-content/v1' ||
      record['artifactRefId'] !== evidence.artifactRefId ||
      !(CONTENT_REASONS as readonly unknown[]).includes(record['reason'])
    ) return reject('review evidence unavailable content is invalid');
    return {
      schema: 'hercules-review-evidence-content/v1',
      kind: 'unavailable',
      artifactRefId: evidence.artifactRefId,
      reason: record['reason'] as Extract<ReviewEvidenceContentDto, { kind: 'unavailable' }>['reason'],
    };
  }
  const extraKey = kind === 'text' ? 'text' : kind === 'image' ? 'authenticatedPath' : null;
  if (extraKey === null) return reject('review evidence content kind is invalid');
  const record = exactRecord(value, [
    'schema', 'kind', 'artifactRefId', 'sha256', 'mediaType', 'redactionState', extraKey,
  ]);
  if (
    record['schema'] !== 'hercules-review-evidence-content/v1' ||
    record['artifactRefId'] !== evidence.artifactRefId ||
    record['sha256'] !== evidence.sha256 ||
    record['redactionState'] !== evidence.redactionState ||
    evidence.redactionState === 'restricted' ||
    typeof record['mediaType'] !== 'string' ||
    record['mediaType'].length === 0 ||
    record['mediaType'].length > 256
  ) return reject('review evidence binding is invalid');
  if (kind === 'text') {
    if (
      typeof record['text'] !== 'string' ||
      encoder.encode(record['text']).byteLength > 256 * 1024
    ) return reject('review evidence text is invalid');
    return {
      schema: 'hercules-review-evidence-content/v1',
      kind: 'text',
      artifactRefId: evidence.artifactRefId,
      sha256: evidence.sha256,
      mediaType: record['mediaType'],
      redactionState: record['redactionState'] as 'none' | 'redacted',
      text: record['text'],
    };
  }
  return {
    schema: 'hercules-review-evidence-content/v1',
    kind: 'image',
    artifactRefId: evidence.artifactRefId,
    sha256: evidence.sha256,
    mediaType: record['mediaType'],
    redactionState: record['redactionState'] as 'none' | 'redacted',
    authenticatedPath: safeAuthenticatedPath(
      record['authenticatedPath'],
      `/api/v2/tasks/${encodeURIComponent(expected.taskId)}/review-evidence/${encodeURIComponent(evidence.artifactRefId)}/content/${encodeURIComponent(expected.projectionHash)}`,
    ),
  };
}
