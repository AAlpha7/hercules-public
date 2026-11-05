import { ReviewDtoDecodeError, type ReviewPackageV2Dto } from './reviewTypes.js';

function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`);
  return `{${entries.join(',')}}`;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function reviewCanonicalHash(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ReviewDtoDecodeError('review integrity verification is unavailable');
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonicalSerialize(value)),
    );
  } catch {
    throw new ReviewDtoDecodeError('review integrity verification failed');
  }
  return `sha256:${hex(digest)}`;
}

export async function assertReviewPackageProjectionIntegrity(
  packageValue: ReviewPackageV2Dto,
): Promise<void> {
  const { projectionHash: expected, ...boundFields } = packageValue;
  if (await reviewCanonicalHash(boundFields) !== expected) {
    throw new ReviewDtoDecodeError('review package projection hash does not match its fields');
  }
}
