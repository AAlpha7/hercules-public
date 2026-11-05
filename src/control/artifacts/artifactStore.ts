import type {
  ArtifactAccessContext,
  ArtifactArchiveAdmissionToken,
  Sha256Digest,
} from './archiveTypes.js';
import type { ArchiveLockLease } from './archiveLock.js';

export { MAX_ARTIFACT_BYTES } from './archiveTypes.js';
export type { Sha256Digest } from './archiveTypes.js';

export const ARTIFACT_CONTENT_ERROR_REASONS = [
  'invalid_size_limit',
  'content_too_large',
  'invalid_digest',
  'invalid_byte_length',
  'unsafe_root',
  'root_overlap',
  'unsafe_directory',
  'unsafe_content_file',
  'missing_content',
  'digest_mismatch',
  'length_mismatch',
  'identity_changed',
  'unsafe_temp',
  'unknown_archive_entry',
  'invalid_orphan_request',
  'orphan_is_referenced',
  'invalid_access_policy',
  'store_closed',
  'fault_injected',
  'io_failure',
] as const;

export type ArtifactContentErrorReason =
  (typeof ARTIFACT_CONTENT_ERROR_REASONS)[number];

export class ArtifactContentError extends Error {
  readonly code: 'artifact_content' | 'artifact_integrity';
  readonly reason: ArtifactContentErrorReason;
  readonly operation: string;
  readonly errno: string | null;

  constructor(
    reason: ArtifactContentErrorReason,
    input: {
      readonly operation?: string;
      readonly errno?: string | null;
    } = {},
  ) {
    const integrity = new Set<ArtifactContentErrorReason>([
      'unsafe_root',
      'root_overlap',
      'unsafe_directory',
      'unsafe_content_file',
      'missing_content',
      'digest_mismatch',
      'length_mismatch',
      'identity_changed',
      'unsafe_temp',
      'unknown_archive_entry',
      'orphan_is_referenced',
      'invalid_access_policy',
      'store_closed',
    ]).has(reason);
    const operation = input.operation ?? 'content';
    const errorNumber = input.errno ?? null;
    super(
      `${integrity ? 'artifact_integrity' : 'artifact_content'}: ${reason}; operation=${operation}` +
        (errorNumber === null ? '' : `; errno=${errorNumber}`),
    );
    this.name = 'ArtifactContentError';
    this.code = integrity ? 'artifact_integrity' : 'artifact_content';
    this.reason = reason;
    this.operation = operation;
    this.errno = errorNumber;
  }
}

export interface ArtifactContentWrite {
  /** Caller memory is copied before validation; paths are never accepted. */
  readonly bytes: Uint8Array;
}

export interface ArtifactContentReceipt {
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly storageKey: string;
}

export interface ArtifactOrphan {
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly modifiedAt: string;
}

export interface ArtifactContentStore {
  verifyClosedLayout(
    token: ArtifactArchiveAdmissionToken,
    lease: ArchiveLockLease,
  ): Promise<void>;
  withLease<T>(
    token: ArtifactArchiveAdmissionToken,
    operation: (lease: ArchiveLockLease) => Promise<T>,
  ): Promise<T>;
  put(
    token: ArtifactArchiveAdmissionToken,
    input: ArtifactContentWrite,
    lease: ArchiveLockLease,
  ): Promise<ArtifactContentReceipt>;
  read(
    token: ArtifactArchiveAdmissionToken,
    sha256: Sha256Digest,
    access: ArtifactAccessContext,
    lease: ArchiveLockLease,
  ): Promise<Uint8Array>;
  verify(
    token: ArtifactArchiveAdmissionToken,
    sha256: Sha256Digest,
    byteLength: number,
    lease: ArchiveLockLease,
  ): Promise<ArtifactContentReceipt>;
  exportVerified(
    token: ArtifactArchiveAdmissionToken,
    sha256: Sha256Digest,
    byteLength: number,
    lease: ArchiveLockLease,
  ): Promise<Uint8Array>;
  removeRetired(
    token: ArtifactArchiveAdmissionToken,
    sha256: Sha256Digest,
    lease: ArchiveLockLease,
  ): Promise<void>;
  scanOrphans(
    token: ArtifactArchiveAdmissionToken,
    cutoff: Date,
    limit: number,
    referencedDigests: ReadonlySet<Sha256Digest>,
    lease: ArchiveLockLease,
  ): Promise<readonly ArtifactOrphan[]>;
  removeOrphan(
    token: ArtifactArchiveAdmissionToken,
    orphan: ArtifactOrphan,
    activeDigests: ReadonlySet<Sha256Digest>,
    lease: ArchiveLockLease,
  ): Promise<void>;
  close(token: ArtifactArchiveAdmissionToken): Promise<void>;
}
