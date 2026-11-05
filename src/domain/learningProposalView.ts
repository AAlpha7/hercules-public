import { isValidIdentifier } from './task.js';

export interface LearningProposalViewV1 {
  readonly schema: 'hercules-learning-proposal-view/v1';
  readonly id: string;
  readonly taskId: string;
  readonly projectionHash: string;
  readonly title: string;
  readonly advisorySummary: string;
  readonly status: 'proposed' | 'accepted' | 'rejected';
  readonly evidenceArtifactIds: readonly string[];
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function isDenseArray(value: readonly unknown[]): boolean {
  return Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index));
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an exact object`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const own = Object.keys(record);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} has an invalid schema`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !isValidIdentifier(value) ||
    encoder.encode(value).byteLength > 256
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    encoder.encode(value).byteLength > 8 * 1024
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function evidenceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !isDenseArray(value) || value.length > 4_096) {
    throw new TypeError('learning proposal evidence must be a bounded array');
  }
  const result = value.map((item, index) => identifier(item, `evidence id ${index}`));
  if (result.some((item, index) => index > 0 && result[index - 1]! >= item)) {
    throw new TypeError('learning proposal evidence must be sorted and unique');
  }
  return Object.freeze(result);
}

export function snapshotLearningProposalViewsV1(
  value: unknown,
): readonly Readonly<LearningProposalViewV1>[] {
  if (!Array.isArray(value) || !isDenseArray(value) || value.length > 4_096) {
    throw new TypeError('learning proposals must be a bounded array');
  }
  const result = value.map((item, index): Readonly<LearningProposalViewV1> => {
    const record = exactRecord(item, [
      'schema', 'id', 'taskId', 'projectionHash', 'title', 'advisorySummary', 'status',
      'evidenceArtifactIds',
    ], `learning proposal ${index}`);
    if (
      record['schema'] !== 'hercules-learning-proposal-view/v1' ||
      typeof record['projectionHash'] !== 'string' ||
      !SHA256.test(record['projectionHash']) ||
      (record['status'] !== 'proposed' &&
        record['status'] !== 'accepted' &&
        record['status'] !== 'rejected')
    ) throw new TypeError(`learning proposal ${index} is invalid`);
    return Object.freeze({
      schema: 'hercules-learning-proposal-view/v1',
      id: identifier(record['id'], `learning proposal ${index} id`),
      taskId: identifier(record['taskId'], `learning proposal ${index} taskId`),
      projectionHash: record['projectionHash'],
      title: text(record['title'], `learning proposal ${index} title`),
      advisorySummary: text(record['advisorySummary'], `learning proposal ${index} summary`),
      status: record['status'],
      evidenceArtifactIds: evidenceIds(record['evidenceArtifactIds']),
    });
  });
  if (result.some((item, index) => index > 0 && result[index - 1]!.id >= item.id)) {
    throw new TypeError('learning proposals must be sorted and unique');
  }
  return Object.freeze(result);
}
