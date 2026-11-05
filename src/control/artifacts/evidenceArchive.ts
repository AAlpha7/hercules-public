import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { canonicalClone, canonicalSerialize, hashCanonicalJson } from '../../domain/canonicalJson.js';
import { candidateRefsEqual } from '../../domain/artifact.js';
import type { ControlEventMetadata } from '../../domain/controlEvent.js';
import {
  SqliteArtifactMetadataStore,
} from '../state/sqliteArtifactMetadataStore.js';
import type {
  ArchivedArtifactMetadata,
  ArtifactMetadataCommitReceipt,
  ArtifactMetadataIntegrityReport,
  ArtifactMetadataRefState,
  ArtifactMetadataStore,
  ArtifactSealedMutationSnapshot,
} from '../state/artifactMetadataStore.js';
import {
  ArchiveAnchorError,
  openFilesystemArchiveAnchorStore,
  type ArtifactArchiveAnchor,
  type ArtifactSealedSnapshot,
  type FilesystemArchiveAnchorStore,
} from './archiveAnchor.js';
import {
  ArchiveLockError,
  openArchiveLockManager,
  type ArchiveLockLease,
  type ArchiveLockManager,
} from './archiveLock.js';
import {
  ArchiveTypeError,
  assertArchiveIdentifier,
  assertArtifactAccessContextCapability,
  assertCanonicalUtcTimestamp,
  bindRecordArtifactObservation,
  createArtifactArchiveAdmissionGate,
  deriveArtifactCaptureAuthorization,
  snapshotArtifactEvidenceArchiveOptions,
  snapshotIssueArtifactCaptureAuthorizationRequest,
  snapshotRecordArtifactInput,
  snapshotRecordEvidenceManifestCommand,
  snapshotRetireArtifactCommand,
  type ArchiveAuthorityContext,
  type ArchivedArtifactRef,
  type ArchivedEvidenceManifest,
  type ArtifactAccessContext,
  type ArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionToken,
  type ArtifactCaptureAuthorization,
  type ArtifactEvidenceArchiveOptions,
  type ArtifactEvidenceArchiveOptionsSnapshot,
  type ArtifactReadResult,
  type ArtifactRetirement,
  type IssueArtifactCaptureAuthorizationRequest,
  type RecordArtifactCommand,
  type RecordEvidenceManifestCommand,
  type RetireArtifactCommand,
  type Sha256Digest,
} from './archiveTypes.js';
import {
  ArtifactContentError,
  type ArtifactOrphan,
} from './artifactStore.js';
import { scanArtifactSecrets } from './secretScanner.js';
import {
  ArtifactExportError,
  publishArtifactExport,
  snapshotArtifactExportBundleName,
  verifyArtifactExport,
  type ArtifactExportIntegrityReport,
  type ArtifactExportReceipt,
} from './archiveExport.js';
import {
  assertProspectiveRootsNonOverlapping,
  openFilesystemArtifactStore,
  prepareFilesystemArtifactRoot,
  type FilesystemArtifactStore,
} from './filesystemArtifactStore.js';

const ARCHIVE_ACTOR = Object.freeze({ kind: 'control_plane' as const, id: 'artifact-archive' });

export type ArtifactEvidenceArchiveErrorCode =
  | 'busy'
  | 'closed'
  | 'integrity'
  | 'invalid_input';

export class ArtifactEvidenceArchiveError extends Error {
  override readonly name = 'ArtifactEvidenceArchiveError';

  constructor(
    readonly code: ArtifactEvidenceArchiveErrorCode,
    message: string,
    readonly originalCause?: unknown,
  ) {
    super(message);
  }
}

export interface ArtifactIntegrityReport {
  readonly schema: 'hercules-artifact-integrity/v1';
  readonly databaseLineageId: string;
  readonly metadata: ArtifactMetadataIntegrityReport;
  readonly anchorCount: number;
  readonly lastAnchorHash: string | null;
  readonly verifiedBlobCount: number;
  readonly orphans: readonly ArtifactOrphan[];
  readonly limitation: 'not_administrator_resistant';
}

export interface ArtifactEvidenceArchive {
  issueCaptureAuthorization(
    request: IssueArtifactCaptureAuthorizationRequest,
    authority: ArchiveAuthorityContext,
  ): Promise<ArtifactCaptureAuthorization>;
  recordArtifact(command: RecordArtifactCommand): Promise<ArchivedArtifactRef>;
  recordManifest(command: RecordEvidenceManifestCommand): Promise<ArchivedEvidenceManifest>;
  readArtifact(id: string, access: ArtifactAccessContext): Promise<ArtifactReadResult>;
  readManifest(id: string): Promise<ArchivedEvidenceManifest | null>;
  retireArtifact(command: RetireArtifactCommand): Promise<ArtifactRetirement>;
  verifyAll(): Promise<ArtifactIntegrityReport>;
  exportSnapshot(bundleName: string): Promise<ArtifactExportReceipt>;
  verifyExportSnapshot(bundleName: string): Promise<ArtifactExportIntegrityReport>;
  close(): Promise<void>;
}

function fail(
  code: ArtifactEvidenceArchiveErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new ArtifactEvidenceArchiveError(code, message, cause);
}

function nowFrom(options: ArtifactEvidenceArchiveOptionsSnapshot): string {
  let value: unknown;
  try {
    value = options.clock();
  } catch (error) {
    fail('invalid_input', 'archive clock failed', error);
  }
  assertCanonicalUtcTimestamp(value, 'archive clock');
  return value;
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex')}`;
}

function eventFor(kind: string, idempotencyKey: string, occurredAt: string): ControlEventMetadata {
  return Object.freeze({
    eventId: deterministicId('artifact-event', `${kind}\0${idempotencyKey}`),
    actor: ARCHIVE_ACTOR,
    occurredAt,
  });
}

function recordArtifactIdempotencyKey(authorizationId: string): string {
  return deterministicId('record-artifact', authorizationId);
}

function lineageIdFor(input: {
  readonly root: string;
  readonly device: number;
  readonly inode: number;
  readonly databasePath: string;
}): string {
  return hashCanonicalJson({
    schema: 'hercules-artifact-lineage/v1',
    artifactRoot: input.root,
    rootDevice: input.device,
    rootInode: input.inode,
    databasePath: input.databasePath,
  });
}

function sealedSnapshot(
  lineageId: string,
  value: ArtifactSealedMutationSnapshot,
): Readonly<ArtifactSealedSnapshot> {
  return Object.freeze({
    schema: 'hercules-artifact-sealed-snapshot/v1',
    lineageId,
    eventId: value.receipt.eventId,
    mutationKind: value.mutation.mutationKind,
    aggregateId: value.mutation.aggregateId,
    requestDigest: value.mutation.requestDigest,
    sealedThroughSequence: value.mutation.sealedThroughSequence,
    sealedThroughEventHash: value.mutation.sealedThroughEventHash,
    inventoryDigest: value.mutation.v3InventoryDigest,
    receiptDigest: hashCanonicalJson(value.receipt),
    committedAt: value.receipt.committedAt,
  });
}

function snapshotFromReceipt(
  lineageId: string,
  receipt: ArtifactMetadataCommitReceipt,
): Readonly<ArtifactSealedSnapshot> {
  return Object.freeze({
    schema: 'hercules-artifact-sealed-snapshot/v1',
    lineageId,
    eventId: receipt.eventId,
    mutationKind: receipt.mutationKind,
    aggregateId: receipt.aggregateId,
    requestDigest: receipt.requestDigest,
    sealedThroughSequence: receipt.sealedThroughSequence,
    sealedThroughEventHash: receipt.sealedThroughEventHash,
    inventoryDigest: receipt.v3InventoryDigest,
    receiptDigest: hashCanonicalJson(receipt),
    committedAt: receipt.committedAt,
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

function scanArtifactMetadata(value: unknown): void {
  scanArtifactSecrets({ bytes: Buffer.from(canonicalSerialize(value), 'utf8') });
}

function isPoisoningFailure(error: unknown): boolean {
  if (error instanceof ArtifactExportError) return false;
  return (
    error instanceof ArchiveLockError ||
    (error instanceof ArtifactContentError && error.code === 'artifact_integrity') ||
    (error instanceof ArchiveAnchorError && error.code !== 'invalid_input') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code: unknown }).code === 'integrity')
  );
}

function findArtifactState(
  metadata: ArtifactMetadataStore,
  token: ArtifactArchiveAdmissionToken,
  id: string,
  pageSize: number,
): ArtifactMetadataRefState | null {
  let cursor: string | null = null;
  do {
    const page = metadata.listArtifactRefs(token, cursor, pageSize);
    for (const item of page.items) {
      if (item.artifact.id === id) return item;
      if (item.artifact.id > id) return null;
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return null;
}

function contentAccessClass(
  metadata: ArtifactMetadataStore,
  token: ArtifactArchiveAdmissionToken,
  digest: Sha256Digest,
  pageSize: number,
): 'operator' | 'restricted' {
  let cursor: string | null = null;
  do {
    const page = metadata.listContentPolicies(token, cursor, pageSize);
    for (const item of page.items) {
      if (item.sha256 === digest) return item.accessClass;
      if (item.sha256 > digest) fail('integrity', 'artifact content policy is missing');
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  fail('integrity', 'artifact content policy is missing');
}

async function nextUnanchoredSnapshot(
  metadata: ArtifactMetadataStore,
  anchors: FilesystemArchiveAnchorStore,
  token: ArtifactArchiveAdmissionToken,
  lease: ArchiveLockLease,
  lineageId: string,
): Promise<Readonly<ArtifactSealedSnapshot>> {
  const chain = await anchors.readAll(token, lease);
  const report = metadata.verifyIntegrity(token);
  const latest = chain.at(-1)?.sealedThroughSequence ?? 0;
  const end = report.lastSealedSequence ?? 0;
  for (let sequence = latest + 1; sequence <= end; sequence += 1) {
    const mutation = metadata.readSealedMutation(token, sequence);
    if (mutation !== null) return sealedSnapshot(lineageId, mutation);
  }
  fail('integrity', 'anchor temp has no exact committed SQLite mutation');
}

class ArtifactEvidenceArchiveImpl implements ArtifactEvidenceArchive {
  readonly #options: Readonly<ArtifactEvidenceArchiveOptionsSnapshot>;
  readonly #lineageId: string;
  readonly #gate: ArtifactArchiveAdmissionGate;
  readonly #lock: ArchiveLockManager;
  readonly #lease: ArchiveLockLease;
  readonly #metadata: ArtifactMetadataStore;
  readonly #anchors: FilesystemArchiveAnchorStore;
  readonly #content: FilesystemArtifactStore;
  #state: 'open' | 'closing' | 'closed' = 'open';
  #active: Promise<unknown> | null = null;
  #closePromise: Promise<void> | null = null;
  #poisoned: unknown = null;

  constructor(input: {
    readonly options: Readonly<ArtifactEvidenceArchiveOptionsSnapshot>;
    readonly lineageId: string;
    readonly gate: ArtifactArchiveAdmissionGate;
    readonly lock: ArchiveLockManager;
    readonly lease: ArchiveLockLease;
    readonly metadata: ArtifactMetadataStore;
    readonly anchors: FilesystemArchiveAnchorStore;
    readonly content: FilesystemArtifactStore;
  }) {
    this.#options = input.options;
    this.#lineageId = input.lineageId;
    this.#gate = input.gate;
    this.#lock = input.lock;
    this.#lease = input.lease;
    this.#metadata = input.metadata;
    this.#anchors = input.anchors;
    this.#content = input.content;
  }

  issueCaptureAuthorization(
    request: IssueArtifactCaptureAuthorizationRequest,
    authority: ArchiveAuthorityContext,
  ): Promise<ArtifactCaptureAuthorization> {
    return this.#run(() => {
      const now = nowFrom(this.#options);
      const requestSnapshot = snapshotIssueArtifactCaptureAuthorizationRequest(request);
      const authorization = deriveArtifactCaptureAuthorization(requestSnapshot, authority, now);
      scanArtifactMetadata({ request: requestSnapshot, authorization });
      return Object.freeze({ request: requestSnapshot, authorization });
    }, async (token, prepared) => {
      const receipt = this.#metadata.issueCaptureAuthorization(token, {
        idempotencyKey: prepared.request.idempotencyKey,
        event: eventFor(
          'authorize',
          prepared.request.idempotencyKey,
          prepared.authorization.issuedAt,
        ),
        authorization: prepared.authorization,
      });
      await this.#anchorReceipt(token, receipt);
      const stored = this.#metadata.readAuthorization(token, prepared.authorization.id);
      if (stored === null || !sameCanonical(stored, prepared.authorization)) {
        fail('integrity', 'capture authorization postcondition failed');
      }
      return canonicalClone(stored);
    });
  }

  recordArtifact(command: RecordArtifactCommand): Promise<ArchivedArtifactRef> {
    return this.#run(() => Object.freeze({
      input: snapshotRecordArtifactInput(
        command,
        this.#options.policy.maximumArtifactBytes,
      ),
      operationNow: nowFrom(this.#options),
    }), async (token, prepared) => {
      const authorization = this.#metadata.readAuthorization(
        token,
        prepared.input.authorizationId,
      );
      if (authorization === null) fail('invalid_input', 'capture authorization does not exist');
      const existing = this.#metadata.readArtifact(token, authorization.artifactRefId);
      const capturedAt = existing?.createdAt ?? prepared.operationNow;
      const snapshot = bindRecordArtifactObservation(
        prepared.input,
        {
          maximumArtifactBytes: this.#options.policy.maximumArtifactBytes,
          clockSkewMs: this.#options.policy.clockSkewMs,
        },
        { stageStartedAt: authorization.issuedAt, capturedAt },
      );
      scanArtifactMetadata({
        authorizationId: snapshot.authorizationId,
        mediaType: snapshot.mediaType,
        observation: snapshot.observation,
      });
      if (
        snapshot.authorizationId !== authorization.id ||
        snapshot.mediaType !== authorization.mediaType ||
        snapshot.byteLength > authorization.maximumByteLength ||
        (authorization.accessClass === 'restricted' &&
          snapshot.observation.accessClass !== 'restricted')
      ) {
        fail('invalid_input', 'artifact command exceeds its capture authorization');
      }
      const receipt = await this.#content.put(token, { bytes: snapshot.bytes }, this.#lease);
      if (receipt.sha256 !== snapshot.sha256 || receipt.byteLength !== snapshot.byteLength) {
        fail('integrity', 'content receipt differs from the owned artifact bytes');
      }
      const artifact: ArchivedArtifactMetadata = Object.freeze({
        id: authorization.artifactRefId,
        sha256: receipt.sha256,
        mediaType: authorization.mediaType,
        byteLength: receipt.byteLength,
        storageKey: receipt.storageKey,
        captureAuthorizationId: authorization.id,
        captureCandidateRef: authorization.candidateRef,
        producerStageRunId: authorization.producerStageRunId,
        createdAt: capturedAt,
        observedAt: snapshot.observation.observedAt,
        environmentRef: authorization.environmentRef,
        surface: authorization.surface,
        trustClass: authorization.maximumTrustClass,
        redactionState: snapshot.observation.redactionState,
        accessClass: snapshot.observation.accessClass,
      });
      if (existing !== null && !sameCanonical(existing, artifact)) {
        fail('invalid_input', 'artifact retry differs from the immutable stored ref');
      }
      const idempotencyKey = recordArtifactIdempotencyKey(authorization.id);
      const metadataReceipt = this.#metadata.recordArtifact(token, {
        idempotencyKey,
        event: eventFor('record', idempotencyKey, artifact.createdAt),
        artifact,
      });
      await this.#anchorReceipt(token, metadataReceipt);
      const stored = this.#metadata.readArtifact(token, artifact.id);
      if (stored === null || !sameCanonical(stored, artifact)) {
        fail('integrity', 'artifact metadata postcondition failed');
      }
      await this.#content.verify(token, artifact.sha256 as Sha256Digest, artifact.byteLength, this.#lease);
      return canonicalClone(stored);
    });
  }

  recordManifest(command: RecordEvidenceManifestCommand): Promise<ArchivedEvidenceManifest> {
    return this.#run(() => {
      const snapshot = snapshotRecordEvidenceManifestCommand(
        command,
        this.#options.policy.maximumCommandEntries,
        this.#options.policy.maximumManifestCriteria,
      );
      scanArtifactMetadata(snapshot);
      return Object.freeze({ snapshot, operationNow: nowFrom(this.#options) });
    }, async (token, prepared) => {
      const snapshot = prepared.snapshot;
      const existing = this.#metadata.readManifest(token, snapshot.id);
      const createdAt = existing?.createdAt ?? prepared.operationNow;
      const artifacts: ArchivedArtifactMetadata[] = [];
      for (const request of snapshot.entries) {
        const state = findArtifactState(
          this.#metadata,
          token,
          request.artifactRefId,
          this.#options.policy.inventoryPageSize,
        );
        if (state === null || state.retirement !== null) {
          fail('invalid_input', 'manifest references an absent or retired artifact');
        }
        await this.#content.verify(
          token,
          state.artifact.sha256 as Sha256Digest,
          state.artifact.byteLength,
          this.#lease,
        );
        artifacts.push(state.artifact);
      }
      const candidate = artifacts[0]?.captureCandidateRef;
      if (
        candidate === undefined ||
        artifacts.some((artifact) => !candidateRefsEqual(artifact.captureCandidateRef, candidate))
      ) {
        fail('invalid_input', 'manifest entries do not share one exact candidate');
      }
      const body = Object.freeze({
        schema: 'hercules-evidence-manifest/v1' as const,
        id: snapshot.id,
        taskId: snapshot.taskId,
        contractVersion: snapshot.contractVersion,
        iterationId: snapshot.iterationId,
        candidateRef: candidate,
        entries: Object.freeze(snapshot.entries.map((request, index) => {
          const artifact = artifacts[index]!;
          return Object.freeze({
            artifactRefId: artifact.id,
            criterionIds: request.criterionIds,
            candidateRef: artifact.captureCandidateRef,
            observedAt: artifact.observedAt,
            environmentRef: artifact.environmentRef,
            surface: artifact.surface,
            trustClass: artifact.trustClass,
            redactionState: artifact.redactionState,
            accessClass: contentAccessClass(
              this.#metadata,
              token,
              artifact.sha256 as Sha256Digest,
              this.#options.policy.inventoryPageSize,
            ),
          });
        })),
        createdAt,
      });
      const manifest: ArchivedEvidenceManifest = Object.freeze({
        ...body,
        manifestHash: hashCanonicalJson(body),
      });
      if (existing !== null && !sameCanonical(existing, manifest)) {
        fail('invalid_input', 'manifest retry differs from the immutable stored manifest');
      }
      const receipt = this.#metadata.recordManifest(token, {
        idempotencyKey: snapshot.idempotencyKey,
        event: eventFor('manifest', snapshot.idempotencyKey, createdAt),
        manifest,
      });
      await this.#anchorReceipt(token, receipt);
      const stored = this.#metadata.readManifest(token, manifest.id);
      if (stored === null || !sameCanonical(stored, manifest)) {
        fail('integrity', 'manifest metadata postcondition failed');
      }
      for (const artifact of artifacts) {
        await this.#content.verify(
          token,
          artifact.sha256 as Sha256Digest,
          artifact.byteLength,
          this.#lease,
        );
      }
      return canonicalClone(stored);
    });
  }

  readArtifact(id: string, access: ArtifactAccessContext): Promise<ArtifactReadResult> {
    return this.#run(() => {
      assertArchiveIdentifier(id, 'artifact id');
      assertArtifactAccessContextCapability(access);
      return Object.freeze({ id, access });
    }, async (token, prepared) => {
      this.#metadata.verifyIntegrity(token);
      const state = findArtifactState(
        this.#metadata,
        token,
        prepared.id,
        this.#options.policy.inventoryPageSize,
      );
      if (state === null || state.retirement !== null) {
        fail('invalid_input', 'artifact is absent or retired');
      }
      const bytes = await this.#content.read(
        token,
        state.artifact.sha256 as Sha256Digest,
        prepared.access,
        this.#lease,
      );
      return Object.freeze({ artifact: canonicalClone(state.artifact), bytes });
    });
  }

  readManifest(id: string): Promise<ArchivedEvidenceManifest | null> {
    return this.#run(() => {
      assertArchiveIdentifier(id, 'manifest id');
      return id;
    }, async (token, preparedId) => {
      this.#metadata.verifyIntegrity(token);
      const manifest = this.#metadata.readManifest(token, preparedId);
      if (manifest === null) return null;
      for (const entry of manifest.entries) {
        const state = findArtifactState(
          this.#metadata,
          token,
          entry.artifactRefId,
          this.#options.policy.inventoryPageSize,
        );
        if (state === null || state.retirement !== null) {
          fail('integrity', 'stored manifest references an absent or retired artifact');
        }
        await this.#content.verify(
          token,
          state.artifact.sha256 as Sha256Digest,
          state.artifact.byteLength,
          this.#lease,
        );
      }
      return canonicalClone(manifest);
    });
  }

  retireArtifact(command: RetireArtifactCommand): Promise<ArtifactRetirement> {
    return this.#run(() => {
      const snapshot = snapshotRetireArtifactCommand(command);
      scanArtifactMetadata(snapshot);
      return Object.freeze({ snapshot, operationNow: nowFrom(this.#options) });
    }, async (token, prepared) => {
      const snapshot = prepared.snapshot;
      const state = findArtifactState(
        this.#metadata,
        token,
        snapshot.artifactRefId,
        this.#options.policy.inventoryPageSize,
      );
      if (state === null) fail('invalid_input', 'artifact to retire does not exist');
      await this.#content.verify(
        token,
        state.artifact.sha256 as Sha256Digest,
        state.artifact.byteLength,
        this.#lease,
      );
      const retiredAt = state.retirement?.retiredAt ?? prepared.operationNow;
      const retirement: ArtifactRetirement = Object.freeze({
        id: snapshot.id,
        artifactRefId: snapshot.artifactRefId,
        reason: snapshot.reason,
        policyCutoff: snapshot.policyCutoff,
        retiredAt,
      });
      if (state.retirement !== null && !sameCanonical(state.retirement, retirement)) {
        fail('invalid_input', 'retirement retry differs from the immutable stored retirement');
      }
      const receipt = this.#metadata.retireArtifact(token, {
        idempotencyKey: snapshot.idempotencyKey,
        event: eventFor('retire', snapshot.idempotencyKey, retiredAt),
        retirement,
      });
      await this.#anchorReceipt(token, receipt);
      const updated = findArtifactState(
        this.#metadata,
        token,
        snapshot.artifactRefId,
        this.#options.policy.inventoryPageSize,
      );
      if (updated === null || !sameCanonical(updated.retirement, retirement)) {
        fail('integrity', 'retirement metadata postcondition failed');
      }
      if (!this.#digestIsReferenced(
        token,
        state.artifact.sha256 as Sha256Digest,
        prepared.operationNow,
      )) {
        try {
          await this.#content.removeRetired(
            token,
            state.artifact.sha256 as Sha256Digest,
            this.#lease,
          );
        } catch (error) {
          if (!(error instanceof ArtifactContentError && error.reason === 'missing_content')) {
            throw error;
          }
        }
      } else {
        await this.#content.verify(
          token,
          state.artifact.sha256 as Sha256Digest,
          state.artifact.byteLength,
          this.#lease,
        );
      }
      return canonicalClone(retirement);
    });
  }

  verifyAll(): Promise<ArtifactIntegrityReport> {
    return this.#run(() => undefined, (token) => this.#verifyAll(token));
  }

  exportSnapshot(bundleName: string): Promise<ArtifactExportReceipt> {
    return this.#run(() => Object.freeze({
      bundleName: snapshotArtifactExportBundleName(bundleName),
      createdAt: nowFrom(this.#options),
    }), async (token, prepared) => {
      await assertProspectiveRootsNonOverlapping([
        this.#options.artifactRoot,
        this.#options.exportRoot,
        this.#options.databaseTrustedRoot,
        this.#options.controlRepositoryRoot,
        ...this.#options.providerWorkRoots,
      ]);
      await this.#verifyAll(token);
      const metadataSnapshot = this.#metadata.createConsistentSnapshot(token);
      const lineage = this.#metadata.readLineage(token);
      const anchors = await this.#anchors.readAll(token, this.#lease);
      const lengths = new Map<string, number>();
      let cursor: string | null = null;
      do {
        const page = this.#metadata.listArtifactRefs(
          token,
          cursor,
          this.#options.policy.inventoryPageSize,
        );
        for (const state of page.items) {
          const prior = lengths.get(state.artifact.sha256);
          if (prior !== undefined && prior !== state.artifact.byteLength) {
            fail('integrity', 'shared export digest has conflicting byte lengths');
          }
          lengths.set(state.artifact.sha256, state.artifact.byteLength);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      const blobs = new Map<Sha256Digest, number>();
      cursor = null;
      do {
        const page = this.#metadata.readDigestInventory(
          token,
          prepared.createdAt,
          cursor,
          this.#options.policy.inventoryPageSize,
        );
        for (const item of page.items) {
          if (
            item.activeArtifactRefIds.length === 0 &&
            item.manifestArtifactRefIds.length === 0 &&
            item.liveCandidateOwnerIds.length === 0
          ) {
            continue;
          }
          const length = lengths.get(item.sha256);
          if (length === undefined) fail('integrity', 'export digest has no artifact metadata');
          blobs.set(item.sha256 as Sha256Digest, length);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      const blobInventory = Object.freeze([...blobs]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([sha256, byteLength]) => Object.freeze({ sha256, byteLength })));
      return publishArtifactExport(this.#options.exportRoot, {
        bundleName: prepared.bundleName,
        createdAt: prepared.createdAt,
        databaseLineageId: this.#lineageId,
        lineage,
        metadata: metadataSnapshot,
        anchors,
        blobs: blobInventory,
        readBlob: (blob) => this.#content.exportVerified(
          token,
          blob.sha256,
          blob.byteLength,
          this.#lease,
        ),
      });
    });
  }

  verifyExportSnapshot(bundleName: string): Promise<ArtifactExportIntegrityReport> {
    return this.#run(
      () => snapshotArtifactExportBundleName(bundleName),
      (_token, preparedName) => verifyArtifactExport(this.#options.exportRoot, preparedName),
      false,
    );
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#state = 'closing';
    const active = this.#active;
    this.#closePromise = (async () => {
      if (active !== null) await active.catch(() => undefined);
      const token = this.#gate.enter();
      let failure: unknown = null;
      try {
        try {
          await this.#content.close(token);
        } catch (error) {
          failure = error;
        }
        try {
          this.#metadata.close(token);
        } catch (error) {
          failure ??= error;
        }
      } finally {
        this.#gate.leave(token);
        try {
          await this.#lease.release();
        } catch (error) {
          failure ??= error;
        }
        this.#state = 'closed';
      }
      if (failure !== null) throw failure;
    })();
    return this.#closePromise;
  }

  async recoverAndVerify(token: ArtifactArchiveAdmissionToken): Promise<ArtifactIntegrityReport> {
    await this.#reconcileAnchors(token);
    await this.#verifyAll(token);
    const now = nowFrom(this.#options);
    await this.#resumeRetiredDeletes(token, now);
    await this.#applyRetention(token, now);
    return this.#verifyAll(token);
  }

  #run<Prepared, Result>(
    prepare: () => Prepared,
    operation: (token: ArtifactArchiveAdmissionToken, prepared: Prepared) => Promise<Result>,
    poisonOperationIntegrity = true,
  ): Promise<Result> {
    if (this.#state !== 'open') return Promise.reject(new ArtifactEvidenceArchiveError('closed', 'artifact archive is closed'));
    if (this.#poisoned !== null) return Promise.reject(this.#poisoned);
    let token: ArtifactArchiveAdmissionToken;
    try {
      token = this.#gate.enter();
    } catch (error) {
      if (error instanceof ArchiveTypeError && error.message.includes('busy')) {
        return Promise.reject(new ArtifactEvidenceArchiveError('busy', 'artifact archive is busy'));
      }
      return Promise.reject(error);
    }
    let prepared: Prepared;
    try {
      prepared = prepare();
    } catch (error) {
      this.#gate.leave(token);
      return Promise.reject(error);
    }
    const active = (async () => {
      try {
        await this.#lock.assertOwns(this.#lease);
        this.#gate.assertOwns(token);
        const result = await operation(token, prepared);
        await this.#lock.assertOwns(this.#lease);
        this.#gate.assertOwns(token);
        return result;
      } catch (error) {
        if (
          error instanceof ArchiveLockError ||
          (poisonOperationIntegrity && isPoisoningFailure(error))
        ) {
          this.#poisoned ??= error;
        }
        throw error;
      } finally {
        this.#gate.leave(token);
      }
    })();
    this.#active = active;
    void active.finally(() => {
      if (this.#active === active) this.#active = null;
    }).catch(() => undefined);
    return active;
  }

  async #anchorReceipt(
    token: ArtifactArchiveAdmissionToken,
    receipt: ArtifactMetadataCommitReceipt,
  ): Promise<Readonly<ArtifactArchiveAnchor>> {
    const persisted = this.#metadata.readSealedMutation(token, receipt.sealedThroughSequence);
    if (persisted === null || !sameCanonical(persisted.receipt, receipt)) {
      fail('integrity', 'sealed SQLite mutation does not reproduce its receipt');
    }
    const expected = sealedSnapshot(this.#lineageId, persisted);
    if (!sameCanonical(expected, snapshotFromReceipt(this.#lineageId, receipt))) {
      fail('integrity', 'sealed SQLite mutation differs from its committed receipt');
    }
    return this.#anchors.append(token, expected, this.#lease);
  }

  /**
   * Sealed mutations keyed by sealed sequence from ONE verified read.
   * `readSealedMutation` re-verifies the whole metadata store per call; used
   * per anchor / per sequence it made production boot O(anchors × mutations
   * × inventory) — ~30 min with 260 anchors (2026-09-09).
   */
  #sealedMutationsBySequence(
    token: ArtifactArchiveAdmissionToken,
  ): ReadonlyMap<number, ArtifactSealedMutationSnapshot> {
    const bySequence = new Map<number, ArtifactSealedMutationSnapshot>();
    for (const snapshot of this.#metadata.readSealedMutations(token)) {
      if (bySequence.has(snapshot.mutation.sealedThroughSequence)) {
        fail('integrity', 'sealed SQLite mutations share a sealed sequence');
      }
      bySequence.set(snapshot.mutation.sealedThroughSequence, snapshot);
    }
    return bySequence;
  }

  async #reconcileAnchors(token: ArtifactArchiveAdmissionToken): Promise<void> {
    const report = this.#metadata.verifyIntegrity(token);
    const existing = await this.#anchors.readAll(token, this.#lease);
    const sealed = this.#sealedMutationsBySequence(token);
    this.#assertAnchorBindings(existing, sealed);
    const last = existing.at(-1)?.sealedThroughSequence ?? 0;
    const end = report.lastSealedSequence ?? 0;
    for (const sequence of [...sealed.keys()].sort((left, right) => left - right)) {
      if (sequence <= last || sequence > end) continue;
      await this.#anchors.append(token, sealedSnapshot(this.#lineageId, sealed.get(sequence)!), this.#lease);
    }
    const completed = await this.#anchors.readAll(token, this.#lease);
    if (completed.length !== report.archiveMutationCount) {
      fail('integrity', 'anchor count differs from the SQLite archive mutation count');
    }
  }

  async #verifyAll(token: ArtifactArchiveAdmissionToken): Promise<ArtifactIntegrityReport> {
    const now = nowFrom(this.#options);
    await this.#content.verifyClosedLayout(token, this.#lease);
    const metadata = this.#metadata.verifyIntegrity(token);
    const anchors = await this.#anchors.readAll(token, this.#lease);
    if (anchors.length !== metadata.archiveMutationCount) {
      fail('integrity', 'archive mutation and anchor counts differ');
    }
    this.#assertAnchorBindings(anchors, this.#sealedMutationsBySequence(token));
    const lengths = new Map<string, number>();
    const referenced = new Set<Sha256Digest>();
    let verifiedBlobCount = 0;
    let cursor: string | null = null;
    do {
      const page = this.#metadata.listArtifactRefs(
        token,
        cursor,
        this.#options.policy.inventoryPageSize,
      );
      for (const state of page.items) {
        const prior = lengths.get(state.artifact.sha256);
        if (prior !== undefined && prior !== state.artifact.byteLength) {
          fail('integrity', 'shared content digest has conflicting byte lengths');
        }
        lengths.set(state.artifact.sha256, state.artifact.byteLength);
        if (state.retirement === null) {
          referenced.add(state.artifact.sha256 as Sha256Digest);
          await this.#content.verify(
            token,
            state.artifact.sha256 as Sha256Digest,
            state.artifact.byteLength,
            this.#lease,
          );
          verifiedBlobCount += 1;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    cursor = null;
    do {
      const page = this.#metadata.readDigestInventory(
        token,
        now,
        cursor,
        this.#options.policy.inventoryPageSize,
      );
      for (const item of page.items) {
        if (
          item.activeArtifactRefIds.length > 0 ||
          item.manifestArtifactRefIds.length > 0 ||
          item.liveCandidateOwnerIds.length > 0
        ) {
          const length = lengths.get(item.sha256);
          if (length === undefined) fail('integrity', 'referenced digest has no artifact metadata');
          referenced.add(item.sha256 as Sha256Digest);
          await this.#content.verify(
            token,
            item.sha256 as Sha256Digest,
            length,
            this.#lease,
          );
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    const cutoff = new Date(
      Date.parse(now) - this.#options.policy.orphanGraceDays * 24 * 60 * 60 * 1_000,
    );
    const orphans = await this.#content.scanOrphans(
      token,
      cutoff,
      this.#options.policy.inventoryPageSize,
      referenced,
      this.#lease,
    );
    return Object.freeze({
      schema: 'hercules-artifact-integrity/v1' as const,
      databaseLineageId: this.#lineageId,
      metadata,
      anchorCount: anchors.length,
      lastAnchorHash: anchors.at(-1)?.anchorHash ?? null,
      verifiedBlobCount,
      orphans: canonicalClone(orphans),
      limitation: 'not_administrator_resistant' as const,
    });
  }

  #digestIsReferenced(
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
    at: string,
  ): boolean {
    let cursor: string | null = null;
    do {
      const page = this.#metadata.readDigestInventory(
        token,
        at,
        cursor,
        this.#options.policy.inventoryPageSize,
      );
      for (const item of page.items) {
        if (item.sha256 === digest) {
          return item.activeArtifactRefIds.length > 0 ||
            item.manifestArtifactRefIds.length > 0 ||
            item.liveCandidateOwnerIds.length > 0;
        }
        if (item.sha256 > digest) return false;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return false;
  }

  #assertAnchorBindings(
    anchors: readonly ArtifactArchiveAnchor[],
    sealed: ReadonlyMap<number, ArtifactSealedMutationSnapshot>,
  ): void {
    let previousAnchorHash: string | null = null;
    for (const anchor of anchors) {
      const mutation = sealed.get(anchor.sealedThroughSequence);
      if (mutation === undefined) fail('integrity', 'anchor is ahead of the SQLite event chain');
      const snapshot = sealedSnapshot(this.#lineageId, mutation);
      const body = Object.freeze({ ...snapshot, previousAnchorHash });
      const expected = Object.freeze({ ...body, anchorHash: hashCanonicalJson(body) });
      if (!sameCanonical(anchor, expected)) {
        fail('integrity', 'anchor differs from the immutable SQLite mutation');
      }
      previousAnchorHash = anchor.anchorHash;
    }
  }

  async #resumeRetiredDeletes(
    token: ArtifactArchiveAdmissionToken,
    at: string,
  ): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = this.#metadata.listArtifactRefs(
        token,
        cursor,
        this.#options.policy.inventoryPageSize,
      );
      for (const state of page.items) {
        if (
          state.retirement === null ||
          this.#digestIsReferenced(token, state.artifact.sha256 as Sha256Digest, at)
        ) {
          continue;
        }
        try {
          await this.#content.removeRetired(
            token,
            state.artifact.sha256 as Sha256Digest,
            this.#lease,
          );
        } catch (error) {
          if (!(error instanceof ArtifactContentError && error.reason === 'missing_content')) {
            throw error;
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  async #applyRetention(
    token: ArtifactArchiveAdmissionToken,
    now: string,
  ): Promise<void> {
    const retentionDays = this.#options.policy.retentionDays;
    if (retentionDays === null) return;
    const cutoff = new Date(
      Date.parse(now) - retentionDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    let cursor: string | null = null;
    do {
      const page = this.#metadata.listRetentionCandidates(
        token,
        cutoff,
        now,
        cursor,
        this.#options.policy.inventoryPageSize,
      );
      for (const artifact of page.items) {
        await this.#content.verify(
          token,
          artifact.sha256 as Sha256Digest,
          artifact.byteLength,
          this.#lease,
        );
        const retirementId = deterministicId('retention', artifact.id);
        const idempotencyKey = deterministicId('retention-command', artifact.id);
        const retirement: ArtifactRetirement = Object.freeze({
          id: retirementId,
          artifactRefId: artifact.id,
          reason: 'retention-policy',
          policyCutoff: cutoff,
          retiredAt: now,
        });
        const receipt = this.#metadata.retireArtifact(token, {
          idempotencyKey,
          event: eventFor('retention', idempotencyKey, now),
          retirement,
        });
        await this.#anchorReceipt(token, receipt);
        if (!this.#digestIsReferenced(token, artifact.sha256 as Sha256Digest, now)) {
          await this.#content.removeRetired(
            token,
            artifact.sha256 as Sha256Digest,
            this.#lease,
          );
        } else {
          await this.#content.verify(
            token,
            artifact.sha256 as Sha256Digest,
            artifact.byteLength,
            this.#lease,
          );
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
}

export async function openArtifactEvidenceArchive(
  value: ArtifactEvidenceArchiveOptions,
): Promise<ArtifactEvidenceArchive> {
  const options = snapshotArtifactEvidenceArchiveOptions(value);
  const forbiddenRoots = Object.freeze([
    options.databaseTrustedRoot,
    options.exportRoot,
    options.controlRepositoryRoot,
    ...options.providerWorkRoots,
  ]);
  await assertProspectiveRootsNonOverlapping([
    options.artifactRoot,
    options.exportRoot,
    options.databaseTrustedRoot,
    options.controlRepositoryRoot,
    ...options.providerWorkRoots,
  ]);
  const prepared = await prepareFilesystemArtifactRoot(options.artifactRoot, forbiddenRoots);
  await assertProspectiveRootsNonOverlapping([
    prepared.root,
    options.exportRoot,
    options.databaseTrustedRoot,
    options.controlRepositoryRoot,
    ...options.providerWorkRoots,
  ]);
  const lock = await openArchiveLockManager(join(prepared.root, '.archive.lock'));
  const lease = await lock.acquire();
  const gate = createArtifactArchiveAdmissionGate();
  const token = gate.enter();
  const lineageId = lineageIdFor({ ...prepared, databasePath: options.databasePath });
  let metadata: SqliteArtifactMetadataStore | null = null;
  let content: FilesystemArtifactStore | null = null;
  try {
    metadata = new SqliteArtifactMetadataStore(gate, {
      trustedRoot: options.databaseTrustedRoot,
      databasePath: options.databasePath,
    });
    const initializedMetadata = metadata;
    initializedMetadata.initialize(token, {
      databaseLineageId: lineageId,
      artifactRoot: prepared.root,
      rootDevice: prepared.device,
      rootInode: prepared.inode,
    });
    const anchors = await openFilesystemArchiveAnchorStore(token, {
      root: prepared.root,
      lineageId,
      lock,
      lifetimeLease: lease,
      admissionGate: gate,
    });
    content = await openFilesystemArtifactStore(token, {
      root: prepared.root,
      admissionGate: gate,
      lock,
      lifetimeLease: lease,
      forbiddenRoots,
      maxArtifactBytes: options.policy.maximumArtifactBytes,
      now: () => new Date(nowFrom(options)),
      resolveAccessClass: (activeToken, digest) => contentAccessClass(
        initializedMetadata,
        activeToken,
        digest,
        options.policy.inventoryPageSize,
      ),
      claimAnchorTemp: async (activeToken, candidate, activeLease) => {
        let expected: Readonly<ArtifactSealedSnapshot>;
        if (candidate.linkCount === 2) {
          const observed = await anchors.inspectTemp(activeToken, candidate, activeLease);
          const mutation = initializedMetadata.readSealedMutation(
            activeToken,
            observed.sealedThroughSequence,
          );
          if (mutation === null) {
            fail('integrity', 'linked anchor temp has no exact committed SQLite mutation');
          }
          expected = sealedSnapshot(lineageId, mutation);
        } else {
          expected = await nextUnanchoredSnapshot(
            initializedMetadata,
            anchors,
            activeToken,
            activeLease,
            lineageId,
          );
        }
        await anchors.claimTemp(activeToken, candidate, expected, activeLease);
      },
    });
    const archive = new ArtifactEvidenceArchiveImpl({
      options,
      lineageId,
      gate,
      lock,
      lease,
      metadata: initializedMetadata,
      anchors,
      content,
    });
    await archive.recoverAndVerify(token);
    gate.leave(token);
    return archive;
  } catch (error) {
    if (content !== null) await content.close(token).catch(() => undefined);
    if (metadata !== null) {
      try {
        metadata.close(token);
      } catch {
        // Preserve the initialization failure.
      }
    }
    await lease.release();
    try {
      gate.leave(token);
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}
