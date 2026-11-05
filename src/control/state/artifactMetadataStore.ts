import type { CandidateRef } from '../../domain/artifact.js';
import type { ControlEventMetadata } from '../../domain/controlEvent.js';
import type {
  ArchivedArtifactRef,
  ArchivedEvidenceManifest,
  ArtifactAccessClass as ArchiveArtifactAccessClass,
  ArtifactCaptureAuthorization,
  ArtifactRetirement,
  ArtifactArchiveAdmissionToken,
} from '../artifacts/archiveTypes.js';
import { CURRENT_STATE_SCHEMA_VERSION } from './migrations.js';

export type ArtifactAccessClass = ArchiveArtifactAccessClass;

export interface ArtifactArchiveLineage {
  readonly databaseLineageId: string;
  readonly artifactRoot: string;
  readonly rootDevice: number;
  readonly rootInode: number;
}

export type ArtifactCaptureAuthorizationRecord = ArtifactCaptureAuthorization;

export interface ArchivedArtifactMetadata extends ArchivedArtifactRef {
  readonly observedAt: string;
  readonly environmentRef: string;
  readonly surface: string;
}

export type ArchivedEvidenceMetadataManifest = ArchivedEvidenceManifest;
export type ArtifactMetadataRetirement = ArtifactRetirement;

interface ArtifactMetadataCommandBase {
  readonly idempotencyKey: string;
  readonly event: ControlEventMetadata;
}

export interface IssueCaptureAuthorizationCommand extends ArtifactMetadataCommandBase {
  readonly authorization: ArtifactCaptureAuthorizationRecord;
}

export interface RecordArtifactMetadataCommand extends ArtifactMetadataCommandBase {
  readonly artifact: ArchivedArtifactMetadata;
}

export interface RecordEvidenceManifestMetadataCommand extends ArtifactMetadataCommandBase {
  readonly manifest: ArchivedEvidenceMetadataManifest;
}

export interface RetireArtifactMetadataCommand extends ArtifactMetadataCommandBase {
  readonly retirement: ArtifactMetadataRetirement;
}

export type ArtifactMetadataMutationKind =
  | 'issue_capture_authorization'
  | 'record_artifact'
  | 'record_manifest'
  | 'retire_artifact';

export interface ArtifactMetadataCommitReceipt {
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly eventHash: string;
  readonly mutationKind: ArtifactMetadataMutationKind;
  readonly aggregateId: string;
  readonly committedAt: string;
  readonly sealedThroughSequence: number;
  readonly sealedThroughEventHash: string;
  readonly v3InventoryDigest: string;
}

export interface ArtifactMetadataIntegrityReport {
  readonly schemaVersion: typeof CURRENT_STATE_SCHEMA_VERSION;
  readonly databaseLineageId: string;
  readonly authorizationCount: number;
  readonly artifactRefCount: number;
  readonly manifestCount: number;
  readonly retirementCount: number;
  readonly archiveMutationCount: number;
  readonly lastSealedSequence: number | null;
  readonly lastSealedEventHash: string | null;
  readonly v3InventoryDigest: string;
}

export interface ArtifactContentPolicyRecord {
  readonly sha256: string;
  readonly accessClass: ArtifactAccessClass;
}

export type ArtifactCandidateBindingOwnerKind =
  | 'capture_authorization'
  | 'artifact_ref'
  | 'iteration'
  | 'manifest';

export interface ArtifactCandidateBindingRecord {
  readonly ownerKind: ArtifactCandidateBindingOwnerKind;
  readonly ownerId: string;
  readonly candidateRef: CandidateRef;
  readonly protectedArtifactRefId: string | null;
  readonly candidateArtifactRefId: string | null;
  readonly candidateArtifactSha256: string | null;
  readonly protectionExpiresAt: string | null;
}

export interface ArtifactMetadataPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ArtifactMetadataRefState {
  readonly artifact: ArchivedArtifactMetadata;
  readonly retirement: ArtifactMetadataRetirement | null;
}

export interface ArtifactManifestCriterionRecord {
  readonly manifestId: string;
  readonly artifactRefId: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly criterionId: string;
  readonly ordinal: number;
}

export interface ArtifactSealedMutationRecord {
  readonly mutationKind: ArtifactMetadataMutationKind;
  readonly aggregateId: string;
  readonly requestDigest: string;
  readonly sealedThroughSequence: number;
  readonly sealedThroughEventHash: string;
  readonly v3InventoryDigest: string;
}

export interface ArtifactSealedMutationSnapshot {
  readonly mutation: ArtifactSealedMutationRecord;
  readonly receipt: ArtifactMetadataCommitReceipt;
}

export interface ArtifactDigestInventoryRecord {
  readonly sha256: string;
  readonly activeArtifactRefIds: readonly string[];
  readonly manifestArtifactRefIds: readonly string[];
  readonly liveCandidateOwnerIds: readonly string[];
  readonly accessClass: ArtifactAccessClass;
}

export interface ArtifactMetadataSqliteSnapshot {
  readonly bytes: Uint8Array;
  readonly databaseSha256: string;
  readonly eventCount: number;
  readonly lastEventHash: string | null;
  readonly v3InventoryDigest: string;
}

export interface ArtifactMetadataStore {
  initialize(token: ArtifactArchiveAdmissionToken, lineage: ArtifactArchiveLineage): ArtifactMetadataIntegrityReport;
  readLineage(token: ArtifactArchiveAdmissionToken): ArtifactArchiveLineage;
  issueCaptureAuthorization(token: ArtifactArchiveAdmissionToken, command: IssueCaptureAuthorizationCommand): ArtifactMetadataCommitReceipt;
  recordArtifact(token: ArtifactArchiveAdmissionToken, command: RecordArtifactMetadataCommand): ArtifactMetadataCommitReceipt;
  recordManifest(token: ArtifactArchiveAdmissionToken, command: RecordEvidenceManifestMetadataCommand): ArtifactMetadataCommitReceipt;
  retireArtifact(token: ArtifactArchiveAdmissionToken, command: RetireArtifactMetadataCommand): ArtifactMetadataCommitReceipt;
  readAuthorization(token: ArtifactArchiveAdmissionToken, id: string): ArtifactCaptureAuthorizationRecord | null;
  readArtifact(token: ArtifactArchiveAdmissionToken, id: string): ArchivedArtifactMetadata | null;
  readManifest(token: ArtifactArchiveAdmissionToken, id: string): ArchivedEvidenceMetadataManifest | null;
  listAuthorizations(token: ArtifactArchiveAdmissionToken, afterId: string | null, limit: number): ArtifactMetadataPage<ArtifactCaptureAuthorizationRecord>;
  listContentPolicies(token: ArtifactArchiveAdmissionToken, afterDigest: string | null, limit: number): ArtifactMetadataPage<ArtifactContentPolicyRecord>;
  listCandidateBindings(token: ArtifactArchiveAdmissionToken, afterKey: string | null, limit: number): ArtifactMetadataPage<ArtifactCandidateBindingRecord>;
  listArtifactRefs(token: ArtifactArchiveAdmissionToken, afterId: string | null, limit: number): ArtifactMetadataPage<ArtifactMetadataRefState>;
  listRetentionCandidates(token: ArtifactArchiveAdmissionToken, cutoff: string, at: string, afterId: string | null, limit: number): ArtifactMetadataPage<ArchivedArtifactMetadata>;
  listManifests(token: ArtifactArchiveAdmissionToken, afterId: string | null, limit: number): ArtifactMetadataPage<ArchivedEvidenceMetadataManifest>;
  listManifestCriteria(token: ArtifactArchiveAdmissionToken, afterKey: string | null, limit: number): ArtifactMetadataPage<ArtifactManifestCriterionRecord>;
  readSealedMutation(token: ArtifactArchiveAdmissionToken, sequence: number): ArtifactSealedMutationSnapshot | null;
  /** Every sealed mutation ascending by sealed sequence, behind ONE integrity pass. */
  readSealedMutations(token: ArtifactArchiveAdmissionToken): readonly ArtifactSealedMutationSnapshot[];
  readDigestInventory(token: ArtifactArchiveAdmissionToken, at: string, afterDigest: string | null, limit: number): ArtifactMetadataPage<ArtifactDigestInventoryRecord>;
  createConsistentSnapshot(token: ArtifactArchiveAdmissionToken): ArtifactMetadataSqliteSnapshot;
  verifyIntegrity(token: ArtifactArchiveAdmissionToken): ArtifactMetadataIntegrityReport;
  close(token: ArtifactArchiveAdmissionToken): void;
}
