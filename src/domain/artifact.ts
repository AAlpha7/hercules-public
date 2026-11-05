import {
  isNonEmptyString,
  isRecord,
  isUniqueStringArray,
  V2InvariantError,
} from './v2Invariant.js';

export type CandidateRef =
  | {
      readonly kind: 'git';
      readonly repository: string;
      readonly revision: string;
    }
  | {
      readonly kind: 'artifact';
      readonly artifactId: string;
      readonly sha256: string;
    }
  | {
      readonly kind: 'external';
      readonly system: string;
      readonly version: string;
      readonly digest: string;
    };

export const ARTIFACT_TRUST_CLASSES = ['primary', 'derived', 'agent_claim'] as const;
export type ArtifactTrustClass = (typeof ARTIFACT_TRUST_CLASSES)[number];
export const ARTIFACT_REDACTION_STATES = ['none', 'redacted', 'restricted'] as const;
export type ArtifactRedactionState = (typeof ARTIFACT_REDACTION_STATES)[number];

export interface ArtifactRef {
  readonly id: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly producerStageRunId: string;
  readonly createdAt: string;
  readonly trustClass: ArtifactTrustClass;
  readonly redactionState: ArtifactRedactionState;
}

export interface EvidenceEntry {
  readonly artifactRefId: string;
  readonly criterionIds: readonly string[];
  readonly candidateRef: CandidateRef;
  readonly observedAt: string;
  readonly environmentRef: string;
  readonly surface: string;
  readonly trustClass: ArtifactTrustClass;
}

export interface EvidenceManifest {
  readonly id: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly entries: readonly EvidenceEntry[];
  readonly manifestHash: string;
  readonly createdAt: string;
}

export function assertArtifactRef(artifact: ArtifactRef): void {
  if (
    !isRecord(artifact) ||
    !isNonEmptyString(artifact.id) ||
    !isNonEmptyString(artifact.sha256) ||
    !isNonEmptyString(artifact.mediaType) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 0 ||
    !isNonEmptyString(artifact.storageKey) ||
    !isNonEmptyString(artifact.producerStageRunId) ||
    !isNonEmptyString(artifact.createdAt) ||
    !(ARTIFACT_TRUST_CLASSES as readonly unknown[]).includes(artifact.trustClass) ||
    !(ARTIFACT_REDACTION_STATES as readonly unknown[]).includes(artifact.redactionState)
  ) {
    throw new V2InvariantError(
      'invalid_artifact_ref',
      'artifact identity, size, provenance, trust, and redaction fields must be valid',
    );
  }
}

function candidateRefIsValid(candidate: CandidateRef): boolean {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    ((candidate.kind === 'git' &&
      typeof candidate.repository === 'string' &&
      candidate.repository.length > 0 &&
      typeof candidate.revision === 'string' &&
      candidate.revision.length > 0) ||
      (candidate.kind === 'artifact' &&
        typeof candidate.artifactId === 'string' &&
        candidate.artifactId.length > 0 &&
        typeof candidate.sha256 === 'string' &&
        candidate.sha256.length > 0) ||
      (candidate.kind === 'external' &&
        typeof candidate.system === 'string' &&
        candidate.system.length > 0 &&
        typeof candidate.version === 'string' &&
        candidate.version.length > 0 &&
        typeof candidate.digest === 'string' &&
        candidate.digest.length > 0))
  );
}

export function assertCandidateRef(candidate: CandidateRef): void {
  if (!candidateRefIsValid(candidate)) {
    const kind =
      candidate !== null && typeof candidate === 'object' && 'kind' in candidate
        ? String(candidate.kind)
        : 'unknown';
    throw new V2InvariantError(
      'invalid_candidate_ref',
      `candidate ${kind} identity fields must be non-empty`,
    );
  }
}

export function candidateRefBinding(candidate: CandidateRef): string {
  assertCandidateRef(candidate);
  if (candidate.kind === 'git') {
    return JSON.stringify(['git', candidate.repository, candidate.revision]);
  }
  if (candidate.kind === 'artifact') {
    return JSON.stringify(['artifact', candidate.artifactId, candidate.sha256]);
  }
  return JSON.stringify([
    'external',
    candidate.system,
    candidate.version,
    candidate.digest,
  ]);
}

export function candidateRefsEqual(left: CandidateRef, right: CandidateRef): boolean {
  if (
    !isRecord(left) ||
    !isRecord(right) ||
    !candidateRefIsValid(left) ||
    !candidateRefIsValid(right)
  ) {
    return false;
  }
  if (left.kind !== right.kind) return false;
  if (left.kind === 'git' && right.kind === 'git') {
    return left.repository === right.repository && left.revision === right.revision;
  }
  if (left.kind === 'artifact' && right.kind === 'artifact') {
    return left.artifactId === right.artifactId && left.sha256 === right.sha256;
  }
  if (left.kind === 'external' && right.kind === 'external') {
    return (
      left.system === right.system &&
      left.version === right.version &&
      left.digest === right.digest
    );
  }
  return false;
}

export function assertEvidenceManifest(manifest: EvidenceManifest): void {
  if (!isRecord(manifest)) {
    throw new V2InvariantError(
      'invalid_evidence_manifest',
      'evidence manifest must be an object',
    );
  }
  if (
    !isNonEmptyString(manifest.id) ||
    !isNonEmptyString(manifest.taskId) ||
    !isNonEmptyString(manifest.iterationId) ||
    !isNonEmptyString(manifest.manifestHash) ||
    !isNonEmptyString(manifest.createdAt)
  ) {
    throw new V2InvariantError(
      'invalid_evidence_manifest',
      'evidence manifest identities must be non-empty',
    );
  }
  if (!Number.isSafeInteger(manifest.contractVersion) || manifest.contractVersion < 1) {
    throw new V2InvariantError(
      'invalid_evidence_manifest',
      'evidence manifest contractVersion must be a positive integer',
    );
  }
  if (!Array.isArray(manifest.entries)) {
    throw new V2InvariantError(
      'invalid_evidence_manifest',
      'evidence manifest entries must be an array',
    );
  }
  assertCandidateRef(manifest.candidateRef);
  const artifactIds = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !isNonEmptyString(entry.artifactRefId) ||
      !isUniqueStringArray(entry.criterionIds) ||
      entry.criterionIds.length === 0 ||
      !isNonEmptyString(entry.observedAt) ||
      !isNonEmptyString(entry.environmentRef) ||
      !isNonEmptyString(entry.surface) ||
      !(ARTIFACT_TRUST_CLASSES as readonly unknown[]).includes(entry.trustClass)
    ) {
      throw new V2InvariantError(
        'invalid_evidence_manifest',
        'evidence entries must bind at least one criterion and carry valid identity, provenance, and trust class',
      );
    }
    assertCandidateRef(entry.candidateRef);
    if (artifactIds.has(entry.artifactRefId)) {
      throw new V2InvariantError(
        'invalid_evidence_manifest',
        `evidence artifact ids must be non-empty and unique: ${entry.artifactRefId}`,
      );
    }
    if (!candidateRefsEqual(entry.candidateRef, manifest.candidateRef)) {
      throw new V2InvariantError(
        'invalid_evidence_manifest',
        `evidence entry ${entry.artifactRefId} is bound to a different candidate`,
      );
    }
    artifactIds.add(entry.artifactRefId);
  }
}

export function assertEvidenceManifestArtifacts(
  manifest: EvidenceManifest,
  artifacts: readonly ArtifactRef[],
): void {
  assertEvidenceManifest(manifest);
  if (!Array.isArray(artifacts)) {
    throw new V2InvariantError(
      'invalid_evidence_manifest',
      'trusted artifact refs must be an array',
    );
  }
  const artifactsById = new Map<string, ArtifactRef>();
  for (const artifact of artifacts) {
    assertArtifactRef(artifact);
    if (artifactsById.has(artifact.id)) {
      throw new V2InvariantError(
        'invalid_evidence_manifest',
        `trusted artifact ids must be unique: ${artifact.id}`,
      );
    }
    artifactsById.set(artifact.id, artifact);
  }
  for (const entry of manifest.entries) {
    const artifact = artifactsById.get(entry.artifactRefId);
    if (artifact === undefined || artifact.trustClass !== entry.trustClass) {
      throw new V2InvariantError(
        'invalid_evidence_manifest',
        `evidence entry ${entry.artifactRefId} must match trusted artifact identity and trust`,
      );
    }
  }
}
