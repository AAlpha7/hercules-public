import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSerialize, hashCanonicalJson } from '../../../src/domain/canonicalJson.js';
import { compileLegacyTaskContract } from '../../../src/domain/contractCompiler.js';
import type { Iteration } from '../../../src/domain/iteration.js';
import type { StageRun } from '../../../src/domain/stageRun.js';
import { SqliteArtifactMetadataStore } from '../../../src/control/state/sqliteArtifactMetadataStore.js';
import type { ArtifactMetadataFailurePoint } from '../../../src/control/state/sqliteArtifactMetadataStore.js';
import {
  createArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionToken,
} from '../../../src/control/artifacts/archiveTypes.js';
import type {
  ArchivedArtifactMetadata,
  ArchivedEvidenceMetadataManifest,
  ArtifactCaptureAuthorizationRecord,
  ArtifactMetadataStore,
} from '../../../src/control/state/artifactMetadataStore.js';
import { SqliteStateStore } from '../../../src/control/state/sqliteStateStore.js';
import { StateStoreError } from '../../../src/control/state/stateStore.js';

const cleanup: string[] = [];

function fixture(): { readonly root: string; readonly databasePath: string; readonly artifactRoot: string } {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-artifact-metadata-'));
  cleanup.push(parent);
  return {
    root: join(parent, 'state'),
    databasePath: join(parent, 'state', 'shadow.sqlite'),
    artifactRoot: join(parent, 'artifacts'),
  };
}

function event(id: string, occurredAt: string) {
  return {
    eventId: `artifact-event-${id}`,
    actor: { kind: 'control_plane' as const, id: 'artifact-archive' },
    occurredAt,
  };
}

function seedState(target: ReturnType<typeof fixture>): void {
  const state = new SqliteStateStore({
    trustedRoot: target.root,
    databasePath: target.databasePath,
  });
  state.initialize();
  const contract = compileLegacyTaskContract({
    taskId: 'task-1',
    objective: 'Persist evidence',
    body: '## DoD\n- [ ] (mechanical) evidence exists @gate:test',
    context: [],
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: '1', grants: [] },
    verificationPolicy: {
      version: '1',
      requiredEvidence: ['test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: '1', requiredDecisions: [] },
    budgetPolicy: { version: '1', maxCostUsd: null, maxTokens: null, maxDurationMs: null },
    createdBy: { kind: 'human', id: 'owner' },
    createdAt: '2026-08-28T00:00:00.000Z',
  }).contract;
  state.commit({
    idempotencyKey: 'seed-contract',
    event: {
      eventId: 'seed-contract-event',
      actor: { kind: 'control_plane', id: 'fixture' },
      occurredAt: '2026-08-28T00:00:00.000Z',
    },
    mutation: { kind: 'insert_contract_root', contract },
  });
  const iteration: Iteration = {
    id: 'iteration-1',
    taskId: 'task-1',
    contractVersion: 1,
    ordinal: 1,
    state: 'planned',
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt: '2026-08-28T00:01:00.000Z',
    endedAt: null,
    supersedesIterationId: null,
  };
  state.commit({
    idempotencyKey: 'seed-iteration',
    event: {
      eventId: 'seed-iteration-event',
      actor: { kind: 'control_plane', id: 'fixture' },
      occurredAt: '2026-08-28T00:01:00.000Z',
    },
    mutation: { kind: 'put_iteration', iteration },
  });
  const executing = { ...iteration, state: 'executing' as const };
  state.commit({
    idempotencyKey: 'seed-iteration-executing',
    event: {
      eventId: 'seed-iteration-executing-event',
      actor: { kind: 'control_plane', id: 'fixture' },
      occurredAt: '2026-08-28T00:01:10.000Z',
    },
    mutation: { kind: 'put_iteration', iteration: executing },
  });
  state.commit({
    idempotencyKey: 'seed-iteration-verifying',
    event: {
      eventId: 'seed-iteration-verifying-event',
      actor: { kind: 'control_plane', id: 'fixture' },
      occurredAt: '2026-08-28T00:01:20.000Z',
    },
    mutation: {
      kind: 'put_iteration',
      iteration: {
        ...executing,
        state: 'verifying',
        candidateRef: { kind: 'git', repository: 'repo-1', revision: 'a'.repeat(40) },
      },
    },
  });
  const stage: StageRun = {
    id: 'verify-1',
    iterationId: iteration.id,
    type: 'verify',
    attempt: 1,
    state: 'succeeded',
    jobSpecHash: 'sha256:job',
    workerId: 'trusted-verifier',
    agentRunIds: [],
    inputArtifactRefs: [],
    outputArtifactRefs: ['artifact-1'],
    structuredResult: null,
    startedAt: '2026-08-28T00:02:00.000Z',
    endedAt: '2026-08-28T00:03:00.000Z',
    failureClass: null,
  };
  // Seed the terminal stage directly through legal transitions.
  const stages: StageRun[] = [
    { ...stage, state: 'queued', workerId: null, outputArtifactRefs: [], startedAt: null, endedAt: null },
    { ...stage, state: 'leased', outputArtifactRefs: [], startedAt: null, endedAt: null },
    { ...stage, state: 'running', outputArtifactRefs: [], endedAt: null },
    stage,
  ];
  for (const [index, value] of stages.entries()) {
    state.commit({
      idempotencyKey: `seed-stage-${index}`,
      event: {
        eventId: `seed-stage-event-${index}`,
        actor: { kind: 'control_plane', id: 'fixture' },
        occurredAt: `2026-08-28T00:0${2 + index}:00.000Z`,
      },
      mutation: { kind: 'put_stage_run', stageRun: value },
    });
  }
  state.close();
}

type TestMetadataStore = {
  [Key in keyof ArtifactMetadataStore]: ArtifactMetadataStore[Key] extends (
    token: ArtifactArchiveAdmissionToken,
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result
    : never;
};

/** C3.54 diagnostic (not on the ArtifactMetadataStore interface). */
function verifyStats(store: TestMetadataStore): { rowsScannedLastVerify: number } {
  return (store as unknown as { verifyStats(): { rowsScannedLastVerify: number } }).verifyStats();
}

function bindTestStore(
  raw: SqliteArtifactMetadataStore,
  gate: ReturnType<typeof createArtifactArchiveAdmissionGate>,
): TestMetadataStore {
  return new Proxy(raw, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: readonly unknown[]) => {
        const token = gate.enter();
        try {
          return Reflect.apply(value, target, [token, ...args]);
        } finally {
          gate.leave(token);
        }
      };
    },
  }) as unknown as TestMetadataStore;
}

function metadataStore(target: ReturnType<typeof fixture>): TestMetadataStore {
  const gate = createArtifactArchiveAdmissionGate();
  return bindTestStore(new SqliteArtifactMetadataStore(gate, {
    trustedRoot: target.root,
    databasePath: target.databasePath,
  }), gate);
}

function captureAuthorization(
  id = 'capture-1',
  artifactRefId = 'artifact-1',
  accessClass: 'operator' | 'restricted' = 'operator',
): ArtifactCaptureAuthorizationRecord {
  return {
    id,
    artifactRefId,
    taskId: 'task-1',
    contractVersion: 1,
    iterationId: 'iteration-1',
    producerStageRunId: 'verify-1',
    candidateRef: { kind: 'git', repository: 'repo-1', revision: 'a'.repeat(40) },
    mediaType: 'text/plain; charset=utf-8',
    maximumByteLength: 1024,
    environmentRef: 'linux-x64',
    surface: 'cli',
    maximumTrustClass: 'primary',
    accessClass,
    issuer: 'trusted-capture',
    issuedAt: '2026-08-28T00:04:00.000Z',
    expiresAt: '2026-08-28T00:10:00.000Z',
  };
}

function archivedArtifact(
  authorization: ArtifactCaptureAuthorizationRecord,
  sha256 = `sha256:${'b'.repeat(64)}`,
): ArchivedArtifactMetadata {
  const hex = sha256.slice('sha256:'.length);
  return {
    id: authorization.artifactRefId,
    sha256,
    mediaType: authorization.mediaType,
    byteLength: 12,
    storageKey: `sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`,
    captureAuthorizationId: authorization.id,
    captureCandidateRef: authorization.candidateRef,
    producerStageRunId: authorization.producerStageRunId,
    createdAt: '2026-08-28T00:05:00.000Z',
    observedAt: '2026-08-28T00:04:30.000Z',
    environmentRef: authorization.environmentRef,
    surface: authorization.surface,
    trustClass: 'primary',
    redactionState: authorization.accessClass === 'restricted' ? 'restricted' : 'redacted',
    accessClass: authorization.accessClass,
  };
}

function initializeMetadata(
  target: ReturnType<typeof fixture>,
  failureInjector?: (point: ArtifactMetadataFailurePoint) => void,
): TestMetadataStore {
  const gate = createArtifactArchiveAdmissionGate();
  const store = bindTestStore(new SqliteArtifactMetadataStore(gate, {
    trustedRoot: target.root,
    databasePath: target.databasePath,
    ...(failureInjector === undefined ? {} : { failureInjector }),
  }), gate);
  store.initialize({
    databaseLineageId: 'lineage-1',
    artifactRoot: target.artifactRoot,
    rootDevice: 10,
    rootInode: 20,
  });
  return store;
}

function recordBaseArtifact(
  store: TestMetadataStore,
  authorization = captureAuthorization(),
  sha256?: string,
): ArchivedArtifactMetadata {
  store.issueCaptureAuthorization({
    idempotencyKey: `authorize-${authorization.id}`,
    event: event(`authorize-${authorization.id}`, authorization.issuedAt),
    authorization,
  });
  const artifact = archivedArtifact(authorization, sha256);
  store.recordArtifact({
    idempotencyKey: `record-${artifact.id}`,
    event: event(`record-${artifact.id}`, artifact.createdAt),
    artifact,
  });
  return artifact;
}

function manifestFor(
  target: ReturnType<typeof fixture>,
  artifact: ArchivedArtifactMetadata,
): ArchivedEvidenceMetadataManifest {
  const db = new Database(target.databasePath, { readonly: true });
  const contract = JSON.parse(String(db.prepare(`SELECT payload_json FROM shadow_task_contracts
    WHERE task_id = 'task-1' AND version = 1`).pluck().get())) as {
      readonly acceptanceCriteria: readonly { readonly id: string }[];
    };
  db.close();
  const body = {
    schema: 'hercules-evidence-manifest/v1' as const,
    id: 'manifest-1',
    taskId: 'task-1',
    contractVersion: 1,
    iterationId: 'iteration-1',
    candidateRef: artifact.captureCandidateRef,
    entries: [{
      artifactRefId: artifact.id,
      criterionIds: [contract.acceptanceCriteria[0]!.id],
      candidateRef: artifact.captureCandidateRef,
      observedAt: artifact.observedAt,
      environmentRef: artifact.environmentRef,
      surface: artifact.surface,
      trustClass: artifact.trustClass,
      redactionState: artifact.redactionState,
      accessClass: artifact.accessClass,
    }],
    createdAt: '2026-08-28T00:06:00.000Z',
  };
  return { ...body, manifestHash: hashCanonicalJson(body) };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('SQLite artifact metadata store', () => {
  it('requires one registered gate identity and a live per-operation token', () => {
    const target = fixture();
    seedState(target);
    expect(() => new SqliteArtifactMetadataStore({
      enter: () => ({} as ArtifactArchiveAdmissionToken),
      assertOwns: () => undefined,
      leave: () => undefined,
    } as ArtifactArchiveAdmissionGate, {
      trustedRoot: target.root,
      databasePath: target.databasePath,
    })).toThrow('forged');

    const gate = createArtifactArchiveAdmissionGate();
    const foreign = createArtifactArchiveAdmissionGate();
    const accessorOptions = { trustedRoot: target.root, databasePath: target.databasePath };
    Object.defineProperty(accessorOptions, 'databasePath', {
      enumerable: true,
      get: () => { throw new Error('must not invoke option getter'); },
    });
    expect(() => new SqliteArtifactMetadataStore(gate, accessorOptions)).toThrow('own data property');
    const raw = new SqliteArtifactMetadataStore(gate, {
      trustedRoot: target.root,
      databasePath: target.databasePath,
    });
    expect(() => raw.initialize({} as ArtifactArchiveAdmissionToken, {
      databaseLineageId: 'lineage-1', artifactRoot: target.artifactRoot, rootDevice: 10, rootInode: 20,
    })).toThrow('forged or inactive');
    const foreignToken = foreign.enter();
    expect(() => raw.initialize(foreignToken, {
      databaseLineageId: 'lineage-1', artifactRoot: target.artifactRoot, rootDevice: 10, rootInode: 20,
    })).toThrow('forged or inactive');
    foreign.leave(foreignToken);
    const token = gate.enter();
    raw.initialize(token, {
      databaseLineageId: 'lineage-1', artifactRoot: target.artifactRoot, rootDevice: 10, rootInode: 20,
    });
    gate.leave(token);
    expect(() => raw.verifyIntegrity(token)).toThrow('forged or inactive');
    const closeToken = gate.enter();
    raw.close(closeToken);
    gate.leave(closeToken);
  });

  it('rejects accessor commands, sparse arrays, and an excessive total manifest criterion count', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    const hostile = {
      idempotencyKey: 'hostile-command',
      event: event('hostile-command', '2026-08-28T00:04:00.000Z'),
      authorization: captureAuthorization(),
    };
    Object.defineProperty(hostile, 'authorization', {
      enumerable: true,
      get: () => { throw new Error('must not invoke command getter'); },
    });
    expect(() => store.issueCaptureAuthorization(hostile)).toThrow('own data property');

    const artifact = recordBaseArtifact(store);
    const criteria = Array.from({ length: 2_049 }, (_, index) => `criterion-${String(index).padStart(4, '0')}`);
    const entry = {
      artifactRefId: artifact.id,
      criterionIds: criteria,
      candidateRef: artifact.captureCandidateRef,
      observedAt: artifact.observedAt,
      environmentRef: artifact.environmentRef,
      surface: artifact.surface,
      trustClass: artifact.trustClass,
      redactionState: artifact.redactionState,
      accessClass: artifact.accessClass,
    };
    const body = {
      schema: 'hercules-evidence-manifest/v1' as const,
      id: 'oversized-manifest',
      taskId: 'task-1',
      contractVersion: 1,
      iterationId: 'iteration-1',
      candidateRef: artifact.captureCandidateRef,
      entries: [entry, { ...entry, artifactRefId: 'artifact-2' }],
      createdAt: '2026-08-28T00:06:00.000Z',
    };
    expect(() => store.recordManifest({
      idempotencyKey: 'oversized-manifest-command',
      event: event('oversized-manifest-command', body.createdAt),
      manifest: { ...body, manifestHash: hashCanonicalJson(body) },
    })).toThrow('total criteria');
    const sparseEntries = [entry, entry];
    delete sparseEntries[0];
    const sparseBody = { ...body, id: 'sparse-manifest', entries: sparseEntries };
    expect(() => store.recordManifest({
      idempotencyKey: 'sparse-manifest-command',
      event: event('sparse-manifest-command', body.createdAt),
      manifest: { ...sparseBody, manifestHash: `sha256:${'d'.repeat(64)}` },
    })).toThrow('dense array');
    store.close();
  });

  it('binds immutable lineage and atomically records authorization, artifact, event, receipt, and inventory', () => {
    const target = fixture();
    seedState(target);
    const store = metadataStore(target);
    expect(store.initialize({
      databaseLineageId: 'lineage-1',
      artifactRoot: target.artifactRoot,
      rootDevice: 10,
      rootInode: 20,
    })).toMatchObject({ schemaVersion: 7, archiveMutationCount: 0 });

    const authorization = {
      id: 'capture-1',
      artifactRefId: 'artifact-1',
      taskId: 'task-1',
      contractVersion: 1,
      iterationId: 'iteration-1',
      producerStageRunId: 'verify-1',
      candidateRef: {
        kind: 'git' as const,
        repository: 'repo-1',
        revision: 'a'.repeat(40),
      },
      mediaType: 'text/plain; charset=utf-8',
      maximumByteLength: 1024,
      environmentRef: 'linux-x64',
      surface: 'cli',
      maximumTrustClass: 'primary' as const,
      accessClass: 'operator' as const,
      issuer: 'trusted-capture',
      issuedAt: '2026-08-28T00:04:00.000Z',
      expiresAt: '2026-08-28T00:10:00.000Z',
    };
    const authorizationReceipt = store.issueCaptureAuthorization({
      idempotencyKey: 'capture-command-1',
      event: event('capture-1', authorization.issuedAt),
      authorization,
    });
    expect(store.issueCaptureAuthorization({
      idempotencyKey: 'capture-command-1',
      event: event('capture-1', authorization.issuedAt),
      authorization,
    })).toEqual(authorizationReceipt);
    expect(authorizationReceipt).toMatchObject({
      mutationKind: 'issue_capture_authorization',
      eventSequence: 9,
    });

    const artifact = {
      id: 'artifact-1',
      sha256: `sha256:${'b'.repeat(64)}`,
      mediaType: 'text/plain; charset=utf-8',
      byteLength: 12,
      storageKey: `sha256/bb/bb/${'b'.repeat(64)}`,
      captureAuthorizationId: 'capture-1',
      captureCandidateRef: authorization.candidateRef,
      producerStageRunId: 'verify-1',
      createdAt: '2026-08-28T00:05:00.000Z',
      observedAt: '2026-08-28T00:04:30.000Z',
      environmentRef: 'linux-x64',
      surface: 'cli',
      trustClass: 'primary' as const,
      redactionState: 'redacted' as const,
      accessClass: 'operator' as const,
    };
    const artifactReceipt = store.recordArtifact({
      idempotencyKey: 'artifact-command-1',
      event: event('artifact-1', artifact.createdAt),
      artifact,
    });
    expect(artifactReceipt.eventSequence).toBe(10);
    expect(artifactReceipt.v3InventoryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(store.readArtifact('artifact-1')).toEqual(artifact);
    expect(store.verifyIntegrity()).toMatchObject({
      schemaVersion: 7,
      authorizationCount: 1,
      artifactRefCount: 1,
      archiveMutationCount: 2,
      lastSealedSequence: 10,
    });

    store.close();
    const reopened = metadataStore(target);
    expect(reopened.initialize({
      databaseLineageId: 'lineage-1',
      artifactRoot: target.artifactRoot,
      rootDevice: 10,
      rootInode: 20,
    })).toMatchObject({ artifactRefCount: 1, archiveMutationCount: 2 });
    expect(() => reopened.initialize({
      databaseLineageId: 'lineage-other',
      artifactRoot: target.artifactRoot,
      rootDevice: 10,
      rootInode: 20,
    })).toThrow(StateStoreError);
    reopened.close();
  });

  it('rejects changed retries and detects immutable projection tampering on restart', () => {
    const target = fixture();
    seedState(target);
    const store = metadataStore(target);
    store.initialize({
      databaseLineageId: 'lineage-1',
      artifactRoot: target.artifactRoot,
      rootDevice: 10,
      rootInode: 20,
    });
    const command = {
      idempotencyKey: 'capture-command-1',
      event: event('capture-1', '2026-08-28T00:04:00.000Z'),
      authorization: {
        id: 'capture-1',
        artifactRefId: 'artifact-1',
        taskId: 'task-1',
        contractVersion: 1,
        iterationId: 'iteration-1',
        producerStageRunId: 'verify-1',
        candidateRef: { kind: 'git' as const, repository: 'repo-1', revision: 'a'.repeat(40) },
        mediaType: 'text/plain',
        maximumByteLength: 1024,
        environmentRef: 'linux-x64',
        surface: 'cli',
        maximumTrustClass: 'primary' as const,
        accessClass: 'operator' as const,
        issuer: 'trusted-capture',
        issuedAt: '2026-08-28T00:04:00.000Z',
        expiresAt: '2026-08-28T00:10:00.000Z',
      },
    };
    store.issueCaptureAuthorization(command);
    try {
      store.issueCaptureAuthorization({
        ...command,
        authorization: { ...command.authorization, maximumByteLength: 2048 },
      });
      throw new Error('expected idempotency conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(StateStoreError);
      expect((error as StateStoreError).code).toBe('idempotency_conflict');
    }
    store.close();

    const db = new Database(target.databasePath);
    db.exec('DROP TRIGGER artifact_capture_authorizations_no_update');
    db.prepare('UPDATE artifact_capture_authorizations SET surface = ? WHERE authorization_id = ?')
      .run('browser', 'capture-1');
    db.close();

    const reopened = metadataStore(target);
    try {
      reopened.initialize({
        databaseLineageId: 'lineage-1',
        artifactRoot: target.artifactRoot,
        rootDevice: 10,
        rootInode: 20,
      });
      throw new Error('expected integrity failure');
    } catch (error) {
      expect(error).toBeInstanceOf(StateStoreError);
      expect((error as StateStoreError).code).toBe('integrity');
    }
  });

  it('does not label the inherited SQLite export as containing artifact bytes', () => {
    const target = fixture();
    const state = new SqliteStateStore({ trustedRoot: target.root, databasePath: target.databasePath });
    state.initialize();
    const receipt = state.exportSnapshot(join(target.root, 'exports'), 'metadata');
    expect(receipt.artifactContentIncluded).toBe(false);
    expect(existsSync(receipt.bundlePath)).toBe(true);
    state.close();
  });

  it('publishes a complete manifest atomically and exposes stable private archive pages', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    const artifact = recordBaseArtifact(store);
    const manifest = manifestFor(target, artifact);
    const receipt = store.recordManifest({
      idempotencyKey: 'record-manifest-1',
      event: event('record-manifest-1', manifest.createdAt),
      manifest,
    });

    expect(store.readManifest(manifest.id)).toEqual(manifest);
    expect(store.listAuthorizations(null, 1)).toMatchObject({
      items: [{ id: 'capture-1' }],
      nextCursor: null,
    });
    expect(store.listArtifactRefs(null, 1).items[0]).toEqual({ artifact, retirement: null });
    expect(store.listCandidateBindings(null, 1).nextCursor).not.toBeNull();
    expect(store.listManifests(null, 1).items).toEqual([manifest]);
    expect(store.listManifestCriteria(null, 1).items).toHaveLength(1);
    expect(store.readDigestInventory('2026-08-28T00:07:00.000Z', null, 256).items).toEqual([{
      sha256: artifact.sha256,
      activeArtifactRefIds: [artifact.id],
      manifestArtifactRefIds: [artifact.id],
      liveCandidateOwnerIds: [`artifact_ref:${artifact.id}`],
      accessClass: 'operator',
    }]);
    expect(store.readSealedMutation(receipt.sealedThroughSequence)).toMatchObject({
      mutation: {
        mutationKind: 'record_manifest',
        v3InventoryDigest: receipt.v3InventoryDigest,
      },
      receipt,
    });
    // C3.48: the same instance verifies only mutations after its verified
    // prefix on later calls; the report must equal a fresh instance's full pass.
    const warm = store.verifyIntegrity();
    // C3.54: the warm instance re-parsed no immutable V3 row; a fresh instance
    // parses every row and reports identically.
    expect(verifyStats(store).rowsScannedLastVerify).toBe(0);
    const fresh = initializeMetadata(target);
    // Boot (initialize) verified every row once …
    expect(verifyStats(fresh).rowsScannedLastVerify).toBeGreaterThan(0);
    expect(fresh.verifyIntegrity()).toEqual(warm);
    // … and the instance's second pass re-parses none.
    expect(verifyStats(fresh).rowsScannedLastVerify).toBe(0);
    fresh.close();
    // One verified read of every sealed mutation (boot anchors path) agrees
    // with the per-sequence reads and is ascending by sealed sequence.
    const sealed = store.readSealedMutations();
    expect(sealed.length).toBeGreaterThanOrEqual(2);
    const sequences = sealed.map((item) => item.mutation.sealedThroughSequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    for (const item of sealed) {
      expect(store.readSealedMutation(item.mutation.sealedThroughSequence)).toEqual(item);
    }
    expect(sealed.at(-1)?.receipt).toEqual(receipt);
    const snapshot = store.createConsistentSnapshot();
    expect(snapshot.bytes.byteLength).toBeGreaterThan(0);
    expect(snapshot.databaseSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.v3InventoryDigest).toBe(store.verifyIntegrity().v3InventoryDigest);

    const badBody = {
      ...manifest,
      id: 'manifest-bad',
      entries: [{ ...manifest.entries[0]!, criterionIds: ['missing-criterion'] }],
    };
    const badManifest = {
      ...badBody,
      manifestHash: hashCanonicalJson({
        schema: badBody.schema,
        id: badBody.id,
        taskId: badBody.taskId,
        contractVersion: badBody.contractVersion,
        iterationId: badBody.iterationId,
        candidateRef: badBody.candidateRef,
        entries: badBody.entries,
        createdAt: badBody.createdAt,
      }),
    };
    const before = store.verifyIntegrity();
    expect(() => store.recordManifest({
      idempotencyKey: 'record-manifest-bad',
      event: event('record-manifest-bad', '2026-08-28T00:07:00.000Z'),
      manifest: badManifest,
    })).toThrow(StateStoreError);
    expect(store.readManifest('manifest-bad')).toBeNull();
    expect(store.verifyIntegrity()).toEqual(before);
    // The rejected write left no new row to scan.
    expect(verifyStats(store).rowsScannedLastVerify).toBe(0);
    // Codex C3.54 blocker: an entry row inserted out of band (the insert
    // triggers alone permit it) must still fail a warm pass — the live
    // inventory digest no longer equals the latest sealed one.
    const second = recordBaseArtifact(store, captureAuthorization('capture-2', 'artifact-2'), `sha256:${'c'.repeat(64)}`);
    expect(store.verifyIntegrity().artifactRefCount).toBe(2);
    expect(verifyStats(store).rowsScannedLastVerify).toBe(0);
    {
      const raw = new Database(target.databasePath);
      const row = raw.prepare('SELECT * FROM evidence_manifest_entries WHERE manifest_id = ? ORDER BY ordinal LIMIT 1')
        .get(manifest.id) as Record<string, unknown>;
      raw.prepare(`INSERT INTO evidence_manifest_entries (manifest_id, artifact_ref_id, ordinal, candidate_kind,
        candidate_json, observed_at, environment_ref, surface, trust_class, redaction_state, access_class, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        manifest.id, second.id, 7, row['candidate_kind'], row['candidate_json'], row['observed_at'],
        row['environment_ref'], row['surface'], row['trust_class'], row['redaction_state'], row['access_class'],
        row['payload_json'],
      );
      raw.close();
    }
    // Warm pass: the memoized manifest is skipped, the seal check catches it.
    expect(() => store.verifyIntegrity()).toThrow('V3 inventory differs from the latest sealed mutation');
    // The failed pass cleared both memos: the next pass re-parses every row and
    // the manifest's own entry check fires first.
    expect(() => store.verifyIntegrity()).toThrow('manifest entry count differs from payload');
    expect(verifyStats(store).rowsScannedLastVerify).toBeGreaterThan(0);
    {
      const raw = new Database(target.databasePath);
      raw.exec('PRAGMA foreign_keys = ON');
      // Cleanup for the remainder of the test: the delete trigger forbids it, so
      // drop and recreate that trigger around the delete (test-only surgery).
      const sql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'evidence_manifest_entries_no_delete'").pluck().get());
      raw.exec('DROP TRIGGER evidence_manifest_entries_no_delete');
      raw.prepare('DELETE FROM evidence_manifest_entries WHERE manifest_id = ? AND ordinal = 7').run(manifest.id);
      raw.exec(sql);
      raw.close();
    }
    expect(store.verifyIntegrity().artifactRefCount).toBe(2);
    store.close();
  });

  it('derives the exact seven-day pin, enforces retention, and preserves maximum alias restriction', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    const first = recordBaseArtifact(store);
    const restrictedAuthorization = captureAuthorization('capture-2', 'artifact-2', 'restricted');
    const second = recordBaseArtifact(store, restrictedAuthorization, first.sha256);
    expect(store.listContentPolicies(null, 10).items).toEqual([{
      sha256: first.sha256,
      accessClass: 'restricted',
    }]);
    expect(store.listCandidateBindings(null, 10).items.find(
      (binding) => binding.ownerKind === 'artifact_ref' && binding.ownerId === first.id,
    )?.protectionExpiresAt).toBe('2026-09-04T00:05:00.000Z');

    const tooEarly = {
      id: 'retirement-too-early',
      artifactRefId: second.id,
      reason: 'finite retention',
      policyCutoff: '2026-08-28T00:05:00.000Z',
      retiredAt: '2026-09-04T00:04:59.999Z',
    };
    expect(() => store.retireArtifact({
      idempotencyKey: 'retire-too-early',
      event: event('retire-too-early', tooEarly.retiredAt),
      retirement: tooEarly,
    })).toThrow(StateStoreError);
    const retirement = {
      ...tooEarly,
      id: 'retirement-2',
      retiredAt: '2026-09-04T00:05:00.001Z',
    };
    store.retireArtifact({
      idempotencyKey: 'retire-2',
      event: event('retire-2', retirement.retiredAt),
      retirement,
    });
    expect(store.listArtifactRefs(null, 10).items.find(
      (state) => state.artifact.id === second.id,
    )?.retirement).toEqual(retirement);
    expect(store.readDigestInventory('2026-09-04T00:05:00.001Z', null, 256).items[0]?.activeArtifactRefIds)
      .toEqual([first.id]);
    store.close();
  });

  it('rejects a digest restriction upgrade after an immutable operator manifest', () => {
    const target = fixture();
    seedState(target);
    let store = initializeMetadata(target);
    const first = recordBaseArtifact(store);
    const manifest = manifestFor(target, first);
    store.recordManifest({
      idempotencyKey: 'record-manifest-before-upgrade',
      event: event('record-manifest-before-upgrade', manifest.createdAt),
      manifest,
    });
    const restrictedAuthorization = captureAuthorization('capture-2', 'artifact-2', 'restricted');
    store.issueCaptureAuthorization({
      idempotencyKey: 'authorize-restricted-alias-after-manifest',
      event: event('authorize-restricted-alias-after-manifest', restrictedAuthorization.issuedAt),
      authorization: restrictedAuthorization,
    });
    const before = store.verifyIntegrity();
    expect(() => store.recordArtifact({
      idempotencyKey: 'record-restricted-alias-after-manifest',
      event: event('record-restricted-alias-after-manifest', '2026-08-28T00:07:00.000Z'),
      artifact: archivedArtifact(restrictedAuthorization, first.sha256),
    })).toThrow(StateStoreError);
    expect(store.readArtifact(restrictedAuthorization.artifactRefId)).toBeNull();
    expect(store.listContentPolicies(null, 10).items).toEqual([{
      sha256: first.sha256,
      accessClass: 'operator',
    }]);
    expect(store.verifyIntegrity()).toEqual(before);
    store.close();

    store = initializeMetadata(target);
    expect(store.verifyIntegrity()).toEqual(before);
    store.close();
  });

  it.each([
    'after_event',
    'after_projection',
    'after_inventory',
    'before_commit',
  ] as const)('rolls back every V3 table at metadata failure point %s', (selected) => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target, (point) => {
      if (point === selected) throw new Error(`injected ${point}`);
    });
    const authorization = captureAuthorization();
    expect(() => store.issueCaptureAuthorization({
      idempotencyKey: 'faulted-authorization',
      event: event('faulted-authorization', authorization.issuedAt),
      authorization,
    })).toThrow(StateStoreError);
    store.close();

    const reopened = initializeMetadata(target);
    expect(reopened.verifyIntegrity()).toMatchObject({
      authorizationCount: 0,
      archiveMutationCount: 0,
    });
    expect(reopened.listCandidateBindings(null, 10).items).toEqual([]);
    reopened.close();
  });

  it('resolves a before-commit uncertainty through an exact idempotent retry', () => {
    const target = fixture();
    seedState(target);
    let injected = false;
    const store = initializeMetadata(target, (point) => {
      if (point === 'before_commit' && !injected) {
        injected = true;
        throw new Error('one-shot commit uncertainty');
      }
    });
    const authorization = captureAuthorization();
    const command = {
      idempotencyKey: 'uncertain-authorization',
      event: event('uncertain-authorization', authorization.issuedAt),
      authorization,
    };
    expect(() => store.issueCaptureAuthorization(command)).toThrow(StateStoreError);
    const receipt = store.issueCaptureAuthorization(command);
    expect(receipt.mutationKind).toBe('issue_capture_authorization');
    expect(store.verifyIntegrity()).toMatchObject({
      authorizationCount: 1,
      archiveMutationCount: 1,
    });
    store.close();
  });

  it('resolves a real post-commit uncertainty without duplicating the mutation', () => {
    const target = fixture();
    seedState(target);
    let injected = false;
    const store = initializeMetadata(target, (point) => {
      if (point === 'after_commit' && !injected) {
        injected = true;
        throw new Error('caller did not receive committed receipt');
      }
    });
    const authorization = captureAuthorization();
    const command = {
      idempotencyKey: 'post-commit-uncertainty',
      event: event('post-commit-uncertainty', authorization.issuedAt),
      authorization,
    };
    expect(() => store.issueCaptureAuthorization(command)).toThrow(StateStoreError);
    const receipt = store.issueCaptureAuthorization(command);
    expect(receipt.idempotencyKey).toBe(command.idempotencyKey);
    expect(store.verifyIntegrity()).toMatchObject({ authorizationCount: 1, archiveMutationCount: 1 });
    expect(() => store.issueCaptureAuthorization({
      ...command,
      authorization: { ...authorization, maximumByteLength: authorization.maximumByteLength + 1 },
    })).toThrow('idempotency');
    store.close();
  });

  it('fails startup when an earlier sealed inventory fact is consistently rewritten', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    recordBaseArtifact(store);
    store.close();

    const db = new Database(target.databasePath);
    const mutationTrigger = String(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'artifact_archive_mutations_no_update'`).pluck().get());
    const receiptTrigger = String(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'artifact_archive_receipts_no_update'`).pluck().get());
    db.exec('DROP TRIGGER artifact_archive_mutations_no_update');
    db.exec('DROP TRIGGER artifact_archive_receipts_no_update');
    const first = db.prepare(`SELECT m.event_id, m.payload_json, r.result_json
      FROM artifact_archive_mutations m JOIN artifact_archive_receipts r ON r.event_id = m.event_id
      ORDER BY m.sealed_through_sequence LIMIT 1`).get() as {
        readonly event_id: string;
        readonly payload_json: string;
        readonly result_json: string;
      };
    const forgedDigest = `sha256:${'f'.repeat(64)}`;
    const payload = JSON.parse(first.payload_json) as Record<string, unknown>;
    const receipt = JSON.parse(first.result_json) as Record<string, unknown>;
    payload['v3InventoryDigest'] = forgedDigest;
    receipt['v3InventoryDigest'] = forgedDigest;
    db.prepare(`UPDATE artifact_archive_mutations SET v3_inventory_digest = ?, payload_json = ?
      WHERE event_id = ?`).run(forgedDigest, canonicalSerialize(payload), first.event_id);
    db.prepare('UPDATE artifact_archive_receipts SET result_json = ? WHERE event_id = ?')
      .run(canonicalSerialize(receipt), first.event_id);
    db.exec(mutationTrigger);
    db.exec(receiptTrigger);
    db.close();

    const reopened = metadataStore(target);
    expect(() => reopened.initialize({
      databaseLineageId: 'lineage-1', artifactRoot: target.artifactRoot, rootDevice: 10, rootInode: 20,
    })).toThrow(StateStoreError);
  });

  it('fails startup when receipt committedAt no longer matches its exact event', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    store.issueCaptureAuthorization({
      idempotencyKey: 'time-bound-authorization',
      event: event('time-bound-authorization', captureAuthorization().issuedAt),
      authorization: captureAuthorization(),
    });
    store.close();

    const db = new Database(target.databasePath);
    const trigger = String(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'artifact_archive_receipts_no_update'`).pluck().get());
    db.exec('DROP TRIGGER artifact_archive_receipts_no_update');
    const row = db.prepare('SELECT event_id, result_json FROM artifact_archive_receipts LIMIT 1').get() as {
      readonly event_id: string;
      readonly result_json: string;
    };
    const receipt = JSON.parse(row.result_json) as Record<string, unknown>;
    receipt['committedAt'] = '2026-08-28T00:04:01.000Z';
    db.prepare('UPDATE artifact_archive_receipts SET committed_at = ?, result_json = ? WHERE event_id = ?')
      .run(receipt['committedAt'], canonicalSerialize(receipt), row.event_id);
    db.exec(trigger);
    db.close();

    const reopened = metadataStore(target);
    expect(() => reopened.initialize({
      databaseLineageId: 'lineage-1', artifactRoot: target.artifactRoot, rootDevice: 10, rootInode: 20,
    })).toThrow(StateStoreError);
  });

  it('recomputes requestDigest from the immutable event command instead of trusting receipt rows', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    store.issueCaptureAuthorization({
      idempotencyKey: 'digest-bound-authorization',
      event: event('digest-bound-authorization', captureAuthorization().issuedAt),
      authorization: captureAuthorization(),
    });
    store.close();

    const db = new Database(target.databasePath);
    const mutationTrigger = String(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'artifact_archive_mutations_no_update'`).pluck().get());
    const receiptTrigger = String(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'artifact_archive_receipts_no_update'`).pluck().get());
    db.exec('DROP TRIGGER artifact_archive_mutations_no_update');
    db.exec('DROP TRIGGER artifact_archive_receipts_no_update');
    const row = db.prepare(`SELECT m.event_id, m.payload_json, r.result_json
      FROM artifact_archive_mutations m JOIN artifact_archive_receipts r ON r.event_id = m.event_id
      LIMIT 1`).get() as { readonly event_id: string; readonly payload_json: string; readonly result_json: string };
    const forgedDigest = `sha256:${'e'.repeat(64)}`;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const receipt = JSON.parse(row.result_json) as Record<string, unknown>;
    payload['requestDigest'] = forgedDigest;
    receipt['requestDigest'] = forgedDigest;
    db.prepare(`UPDATE artifact_archive_mutations SET request_digest = ?, payload_json = ?
      WHERE event_id = ?`).run(forgedDigest, canonicalSerialize(payload), row.event_id);
    db.prepare(`UPDATE artifact_archive_receipts SET request_digest = ?, result_json = ?
      WHERE event_id = ?`).run(forgedDigest, canonicalSerialize(receipt), row.event_id);
    db.exec(mutationTrigger);
    db.exec(receiptTrigger);
    db.close();

    const reopened = metadataStore(target);
    expect(() => reopened.initialize({
      databaseLineageId: 'lineage-1', artifactRoot: target.artifactRoot, rootDevice: 10, rootInode: 20,
    })).toThrow(StateStoreError);
  });

  it('fails startup on paged candidate-binding semantic tampering with schema restored', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    recordBaseArtifact(store);
    store.close();

    const db = new Database(target.databasePath);
    const triggerSql = String(db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'artifact_candidate_bindings_no_update'`).pluck().get());
    db.exec('DROP TRIGGER artifact_candidate_bindings_no_update');
    db.prepare(`UPDATE artifact_candidate_bindings SET protection_expires_at = ?
      WHERE owner_kind = 'artifact_ref' AND owner_id = 'artifact-1'`)
      .run('2026-09-05T00:05:00.000Z');
    db.exec(triggerSql);
    db.close();

    const reopened = metadataStore(target);
    expect(() => reopened.initialize({
      databaseLineageId: 'lineage-1',
      artifactRoot: target.artifactRoot,
      rootDevice: 10,
      rootInode: 20,
    })).toThrow(StateStoreError);
  });

  it('rejects direct SQL owner, candidate digest, criterion, and live-retirement violations', () => {
    const target = fixture();
    seedState(target);
    const store = initializeMetadata(target);
    const artifact = recordBaseArtifact(store);
    const manifest = manifestFor(target, artifact);
    store.recordManifest({
      idempotencyKey: 'manifest-direct-constraints',
      event: event('manifest-direct-constraints', manifest.createdAt),
      manifest,
    });
    store.close();

    const db = new Database(target.databasePath);
    expect(() => db.prepare(`INSERT INTO artifact_candidate_bindings (
      owner_kind, owner_id, candidate_kind, candidate_json, protected_artifact_ref_id,
      candidate_artifact_ref_id, candidate_artifact_sha256, protection_expires_at
    ) VALUES ('artifact_ref', 'missing-owner', 'git', ?, NULL, NULL, NULL, NULL)`)
      .run(JSON.stringify({ kind: 'git', repository: 'repo-1', revision: 'a'.repeat(40) })))
      .toThrow();
    expect(() => db.prepare(`INSERT INTO artifact_candidate_bindings (
      owner_kind, owner_id, candidate_kind, candidate_json, protected_artifact_ref_id,
      candidate_artifact_ref_id, candidate_artifact_sha256, protection_expires_at
    ) VALUES ('iteration', 'iteration-1', 'artifact', ?, NULL, ?, ?, NULL)`).run(
      JSON.stringify({ kind: 'artifact', artifactId: artifact.id, sha256: `sha256:${'c'.repeat(64)}` }),
      artifact.id,
      `sha256:${'c'.repeat(64)}`,
    )).toThrow();
    expect(() => db.prepare(`INSERT INTO evidence_manifest_criteria (
      manifest_id, artifact_ref_id, task_id, contract_version, criterion_id, ordinal
    ) VALUES (?, ?, 'task-1', 1, 'missing-criterion', 1)`).run(manifest.id, artifact.id))
      .toThrow();
    expect(() => db.prepare(`INSERT INTO shadow_contract_criteria (
      task_id, contract_version, criterion_id
    ) VALUES ('task-1', 1, 'not-in-contract')`).run()).toThrow();
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TRIGGER artifact_candidate_bindings_no_delete');
    db.prepare(`DELETE FROM artifact_candidate_bindings
      WHERE owner_kind = 'capture_authorization' AND owner_id = 'capture-1'`).run();
    expect(() => db.prepare(`INSERT INTO artifact_candidate_bindings (
      owner_kind, owner_id, candidate_kind, candidate_json, protected_artifact_ref_id,
      candidate_artifact_ref_id, candidate_artifact_sha256, protection_expires_at
    ) VALUES ('capture_authorization', 'capture-1', 'git', ?, NULL, ?, ?, ?)`)
      .run(
        canonicalSerialize(captureAuthorization().candidateRef),
        artifact.id,
        artifact.sha256,
        captureAuthorization().expiresAt,
      )).toThrow();
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TRIGGER evidence_manifest_criteria_no_delete');
    db.prepare(`DELETE FROM evidence_manifest_criteria
      WHERE manifest_id = ? AND artifact_ref_id = ?`).run(manifest.id, artifact.id);
    const criterionId = manifest.entries[0]!.criterionIds[0]!;
    expect(() => db.prepare(`INSERT INTO evidence_manifest_criteria (
      manifest_id, artifact_ref_id, task_id, contract_version, criterion_id, ordinal
    ) VALUES (?, ?, 'task-1', 1, ?, 1)`).run(manifest.id, artifact.id, criterionId)).toThrow();
    db.exec('ROLLBACK');
    expect(() => db.prepare(`INSERT INTO artifact_retirements (
      retirement_id, artifact_ref_id, reason, policy_cutoff, retired_at, event_id, payload_json
    ) VALUES ('direct-retirement', ?, 'invalid', ?, ?, 'missing-event', '{}')`).run(
      artifact.id,
      '2026-08-28T00:05:00.000Z',
      '2026-08-29T00:05:00.000Z',
    )).toThrow();
    db.close();
  });

  it('serializes an ordinary writer between archive mutations without breaking sealed replay', () => {
    const target = fixture();
    seedState(target);
    const metadata = initializeMetadata(target);
    const authorization = captureAuthorization();
    metadata.issueCaptureAuthorization({
      idempotencyKey: 'race-authorization',
      event: event('race-authorization', authorization.issuedAt),
      authorization,
    });

    const general = new SqliteStateStore({ trustedRoot: target.root, databasePath: target.databasePath });
    general.initialize();
    const currentStage = general.readTask('task-1')!.stageRuns[0]!;
    general.commit({
      idempotencyKey: 'race-general-writer',
      event: {
        eventId: 'race-general-event',
        actor: { kind: 'control_plane', id: 'ordinary-writer' },
        occurredAt: '2026-08-28T00:04:30.000Z',
      },
      mutation: { kind: 'put_stage_run', stageRun: currentStage },
    });
    general.close();

    const artifact = archivedArtifact(authorization);
    const receipt = metadata.recordArtifact({
      idempotencyKey: 'race-artifact',
      event: event('race-artifact', artifact.createdAt),
      artifact,
    });
    expect(receipt.eventSequence).toBeGreaterThan(10);
    expect(metadata.verifyIntegrity()).toMatchObject({ archiveMutationCount: 2 });
    metadata.close();
  });

  it('holds the immediate transaction against a racing ordinary writer', () => {
    const target = fixture();
    seedState(target);
    const general = new SqliteStateStore({
      trustedRoot: target.root,
      databasePath: target.databasePath,
      busyTimeoutMs: 25,
    });
    general.initialize();
    const stage = general.readTask('task-1')!.stageRuns[0]!;
    let raceError: unknown;
    let attempted = false;
    const metadata = initializeMetadata(target, (point) => {
      if (point !== 'before_commit' || attempted) return;
      attempted = true;
      try {
        general.commit({
          idempotencyKey: 'overlapping-general-writer',
          event: {
            eventId: 'overlapping-general-event',
            actor: { kind: 'control_plane', id: 'ordinary-writer' },
            occurredAt: '2026-08-28T00:04:00.000Z',
          },
          mutation: { kind: 'put_stage_run', stageRun: stage },
        });
      } catch (error) {
        raceError = error;
      }
    });
    const authorization = captureAuthorization();
    metadata.issueCaptureAuthorization({
      idempotencyKey: 'winning-archive-writer',
      event: event('winning-archive-writer', authorization.issuedAt),
      authorization,
    });
    expect(attempted).toBe(true);
    expect(raceError).toBeInstanceOf(StateStoreError);
    expect((raceError as StateStoreError).code).toBe('busy');
    expect(metadata.verifyIntegrity()).toMatchObject({ authorizationCount: 1, archiveMutationCount: 1 });
    general.close();
    metadata.close();
  });
});
