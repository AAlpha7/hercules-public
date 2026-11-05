import { ReviewDtoDecodeError } from './reviewTypes.js';

export interface LearningProposalViewDto {
  readonly schema: 'hercules-learning-proposal-view/v1';
  readonly id: string;
  readonly taskId: string;
  readonly projectionHash: string;
  readonly title: string;
  readonly advisorySummary: string;
  readonly status: 'proposed' | 'accepted' | 'rejected';
  readonly evidenceArtifactIds: readonly string[];
}

const encoder = new TextEncoder();

function isDenseArray(value: readonly unknown[]): boolean {
  return Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index));
}

function reject(message: string): never {
  throw new ReviewDtoDecodeError(message);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value === '.' ||
    value === '..' ||
    encoder.encode(value).byteLength > 256
  ) return reject(`${label} is invalid`);
  return value;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    encoder.encode(value).byteLength > 8 * 1024
  ) return reject(`${label} is invalid`);
  return value;
}

export function decodeLearningProposalViewsV1(
  value: unknown,
  expected: Readonly<{
    taskId: string;
    projectionHash: string;
    evidenceArtifactIds: ReadonlySet<string>;
  }>,
): readonly LearningProposalViewDto[] {
  if (!Array.isArray(value) || !isDenseArray(value) || value.length > 4_096) {
    return reject('learning proposals must be a bounded array');
  }
  const result = value.map((item, index): LearningProposalViewDto => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return reject(`learning proposal ${index} must be an exact object`);
    }
    const record = item as Readonly<Record<string, unknown>>;
    const keys = [
      'schema', 'id', 'taskId', 'projectionHash', 'title', 'advisorySummary', 'status',
      'evidenceArtifactIds',
    ];
    const own = Object.keys(record);
    if (own.length !== keys.length || own.some((key) => !keys.includes(key))) {
      return reject(`learning proposal ${index} has an invalid schema`);
    }
    if (
      record['schema'] !== 'hercules-learning-proposal-view/v1' ||
      record['taskId'] !== expected.taskId ||
      record['projectionHash'] !== expected.projectionHash ||
      (record['status'] !== 'proposed' &&
        record['status'] !== 'accepted' &&
        record['status'] !== 'rejected') ||
      !Array.isArray(record['evidenceArtifactIds']) ||
      !isDenseArray(record['evidenceArtifactIds']) ||
      record['evidenceArtifactIds'].length > 4_096
    ) return reject(`learning proposal ${index} binding is invalid`);
    const evidenceArtifactIds = record['evidenceArtifactIds'].map((id, evidenceIndex) =>
      identifier(id, `learning proposal ${index} evidence ${evidenceIndex}`));
    if (
      evidenceArtifactIds.some((id, evidenceIndex) =>
        !expected.evidenceArtifactIds.has(id) ||
        (evidenceIndex > 0 && evidenceArtifactIds[evidenceIndex - 1]! >= id))
    ) return reject(`learning proposal ${index} evidence is invalid`);
    return {
      schema: 'hercules-learning-proposal-view/v1',
      id: identifier(record['id'], `learning proposal ${index} id`),
      taskId: expected.taskId,
      projectionHash: expected.projectionHash,
      title: text(record['title'], `learning proposal ${index} title`),
      advisorySummary: text(record['advisorySummary'], `learning proposal ${index} summary`),
      status: record['status'],
      evidenceArtifactIds,
    };
  });
  if (result.some((item, index) => index > 0 && result[index - 1]!.id >= item.id)) {
    return reject('learning proposals must be sorted and unique');
  }
  return result;
}
