import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real-filesystem archive suite: 5 s per test flakes under host load (parallel
// reviewers / check:full); the assertions are not timing-sensitive.
vi.setConfig({ testTimeout: 20_000 });

import {
  ArtifactEvidenceArchiveError,
  openArtifactEvidenceArchive,
  type ArtifactEvidenceArchive,
} from '../../../src/control/artifacts/evidenceArchive.js';
import { verifyArtifactExport } from '../../../src/control/artifacts/archiveExport.js';
import {
  TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER,
  type ArtifactEvidenceArchiveOptions,
} from '../../../src/control/artifacts/archiveTypes.js';
import { compileLegacyTaskContract } from '../../../src/domain/contractCompiler.js';
import { canonicalSerialize } from '../../../src/domain/canonicalJson.js';
import type { Iteration } from '../../../src/domain/iteration.js';
import type { StageRun } from '../../../src/domain/stageRun.js';
import { SqliteStateStore } from '../../../src/control/state/sqliteStateStore.js';

const cleanup: string[] = [];
const execFileAsync = promisify(execFile);

interface MutableExportInventory {
  blobs: Array<{ path: string; sha256: string; byteLength: number }>;
}

async function rewriteExportInventory(
  bundleRoot: string,
  mutate: (inventory: MutableExportInventory) => void,
): Promise<void> {
  const inventoryPath = join(bundleRoot, 'inventory.json');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as MutableExportInventory;
  mutate(inventory);
  const inventoryText = canonicalSerialize(inventory);
  await writeFile(inventoryPath, inventoryText);
  const completePath = join(bundleRoot, '.complete');
  const complete = JSON.parse(await readFile(completePath, 'utf8')) as {
    inventorySha256: string;
  };
  complete.inventorySha256 =
    `sha256:${createHash('sha256').update(inventoryText).digest('hex')}`;
  await writeFile(completePath, canonicalSerialize(complete));
}

interface Fixture {
  readonly parent: string;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly exportRoot: string;
  readonly controlRoot: string;
  readonly providerRoot: string;
}

async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'hercules-evidence-archive-'));
  await chmod(parent, 0o700);
  cleanup.push(parent);
  return {
    parent,
    stateRoot: join(parent, 'state'),
    databasePath: join(parent, 'state', 'shadow.sqlite'),
    artifactRoot: join(parent, 'artifacts'),
    exportRoot: join(parent, 'exports'),
    controlRoot: join(parent, 'control'),
    providerRoot: join(parent, 'provider'),
  };
}

function seedState(target: Fixture): string {
  const state = new SqliteStateStore({
    trustedRoot: target.stateRoot,
    databasePath: target.databasePath,
  });
  state.initialize();
  const contract = compileLegacyTaskContract({
    taskId: 'task-1',
    objective: 'Preserve exact evidence',
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
    createdAt: '2026-08-01T00:00:00.000Z',
  }).contract;
  state.commit({
    idempotencyKey: 'seed-contract',
    event: {
      eventId: 'seed-contract-event',
      actor: { kind: 'control_plane', id: 'fixture' },
      occurredAt: '2026-08-01T00:00:00.000Z',
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
    createdAt: '2026-08-01T00:01:00.000Z',
    endedAt: null,
    supersedesIterationId: null,
  };
  for (const [index, value] of [
    iteration,
    { ...iteration, state: 'executing' as const },
    {
      ...iteration,
      state: 'verifying' as const,
      candidateRef: { kind: 'git' as const, repository: 'repo-1', revision: 'a'.repeat(40) },
    },
  ].entries()) {
    state.commit({
      idempotencyKey: `seed-iteration-${index}`,
      event: {
        eventId: `seed-iteration-event-${index}`,
        actor: { kind: 'control_plane', id: 'fixture' },
        occurredAt: `2026-08-01T00:0${index + 1}:00.000Z`,
      },
      mutation: { kind: 'put_iteration', iteration: value },
    });
  }
  const succeeded: StageRun = {
    id: 'verify-1',
    iterationId: iteration.id,
    type: 'verify',
    attempt: 1,
    state: 'succeeded',
    jobSpecHash: 'sha256:job',
    workerId: 'trusted-verifier',
    agentRunIds: [],
    inputArtifactRefs: [],
    outputArtifactRefs: ['artifact-1', 'artifact-2'],
    structuredResult: null,
    startedAt: '2026-08-01T00:02:00.000Z',
    endedAt: '2026-08-01T00:03:00.000Z',
    failureClass: null,
  };
  const stages: StageRun[] = [
    { ...succeeded, state: 'queued', workerId: null, outputArtifactRefs: [], startedAt: null, endedAt: null },
    { ...succeeded, state: 'leased', outputArtifactRefs: [], startedAt: null, endedAt: null },
    { ...succeeded, state: 'running', outputArtifactRefs: [], endedAt: null },
    succeeded,
  ];
  for (const [index, value] of stages.entries()) {
    state.commit({
      idempotencyKey: `seed-stage-${index}`,
      event: {
        eventId: `seed-stage-event-${index}`,
        actor: { kind: 'control_plane', id: 'fixture' },
        occurredAt: `2026-08-01T00:0${index + 4}:00.000Z`,
      },
      mutation: { kind: 'put_stage_run', stageRun: value },
    });
  }
  state.close();
  return contract.acceptanceCriteria[0]!.id;
}

function options(
  target: Fixture,
  clock: () => string,
  retentionDays: number | null = null,
): ArtifactEvidenceArchiveOptions {
  return {
    artifactRoot: target.artifactRoot,
    databasePath: target.databasePath,
    databaseTrustedRoot: target.stateRoot,
    exportRoot: target.exportRoot,
    controlRepositoryRoot: target.controlRoot,
    providerWorkRoots: [target.providerRoot],
    policy: {
      maximumArtifactBytes: 1024 * 1024,
      lockAcquireTimeoutMs: 1_000,
      clockSkewMs: 60_000,
      maximumCommandEntries: 32,
      maximumManifestCriteria: 128,
      inventoryPageSize: 16,
      retentionDays,
      orphanGraceDays: 1,
    },
    clock,
  };
}

function authority(environmentRef = 'linux-x64') {
  return TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArchiveAuthority({
    issuer: 'trusted-capture',
    taskId: 'task-1',
    contractVersion: 1,
    iterationId: 'iteration-1',
    producerStageRunId: 'verify-1',
    stageType: 'verify',
    stageStartedAt: '2026-08-01T00:02:00.000Z',
    candidateRef: { kind: 'git', repository: 'repo-1', revision: 'a'.repeat(40) },
    environmentRef,
    surface: 'cli',
    maximumTrustClass: 'primary',
    maximumAccessClass: 'operator',
    maximumByteLength: 4096,
    allowedMediaTypes: ['text/plain; charset=utf-8'],
    issuedAt: '2026-08-01T00:04:00.000Z',
    expiresAt: '2026-08-01T00:10:00.000Z',
  });
}

async function capture(
  archive: ArtifactEvidenceArchive,
  artifactRefId: string,
  authorizationId: string,
  bytes: Buffer,
  afterAdmission?: () => void,
) {
  await archive.issueCaptureAuthorization({
    id: authorizationId,
    artifactRefId,
    idempotencyKey: `issue-${authorizationId}`,
    mediaType: 'text/plain; charset=utf-8',
    maximumByteLength: 4096,
    accessClass: 'operator',
  }, authority());
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const observation = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueCaptureObservation({
    authorizationId,
    sha256: digest,
    byteLength: bytes.byteLength,
    redactionState: 'redacted',
    accessClass: 'operator',
    observedAt: '2026-08-01T00:04:30.000Z',
  });
  const result = archive.recordArtifact({
    authorizationId,
    observation,
    mediaType: 'text/plain; charset=utf-8',
    bytes,
  });
  afterAdmission?.();
  return result;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('artifact evidence archive coordinator', () => {
  it('records, anchors, reads, manifests, and verifies exact evidence under one admission gate', async () => {
    const target = await fixture();
    const criterionId = seedState(target);
    const absentExportRoot = join(target.parent, 'absent-exports');
    await expect(verifyArtifactExport(absentExportRoot, 'missing-bundle')).rejects.toMatchObject({
      code: 'unsafe_path',
    });
    await expect(lstat(absentExportRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    let now = '2026-08-01T00:04:00.000Z';
    const archive = await openArtifactEvidenceArchive(options(target, () => now));
    now = '2026-08-01T00:05:00.000Z';
    const callerBytes = Buffer.from('verified command output');
    const artifact = await capture(
      archive,
      'artifact-1',
      'authorization-1',
      callerBytes,
      () => callerBytes.fill(0),
    );
    const access = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArtifactAccess({
      sha256: artifact.sha256,
      purpose: 'read',
      authorizationClass: 'operator',
      issuer: 'trusted-operator',
      issuedAt: '2026-08-01T00:05:00.000Z',
      expiresAt: '2026-08-01T00:07:00.000Z',
    });
    expect(Buffer.from((await archive.readArtifact(artifact.id, access)).bytes).toString('utf8'))
      .toBe('verified command output');

    now = '2026-08-01T00:06:00.000Z';
    const manifest = await archive.recordManifest({
      id: 'manifest-1',
      idempotencyKey: 'record-manifest-1',
      taskId: 'task-1',
      contractVersion: 1,
      iterationId: 'iteration-1',
      entries: [{ artifactRefId: artifact.id, criterionIds: [criterionId] }],
    });
    expect(await archive.readManifest(manifest.id)).toEqual(manifest);
    const report = await archive.verifyAll();
    expect(report).toMatchObject({
      schema: 'hercules-artifact-integrity/v1',
      anchorCount: 3,
      verifiedBlobCount: 1,
      orphans: [],
      limitation: 'not_administrator_resistant',
    });
    await expect(archive.exportSnapshot('bundle-1')).resolves.toMatchObject({
      schema: 'hercules-artifact-export-receipt/v1',
      bundleName: 'bundle-1',
      anchorCount: 3,
      blobCount: 1,
    });
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-1')).resolves.toMatchObject({
      bundleName: 'bundle-1',
      anchorCount: 3,
      blobCount: 1,
      limitation: 'internally_consistent_not_authenticity_signed',
    });
    const bundleRoot = join(target.exportRoot, 'bundle-1');
    await unlink(join(bundleRoot, '.complete'));
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-1')).rejects.toMatchObject({
      code: 'integrity',
    });
    await expect(archive.exportSnapshot('bundle-1')).resolves.toMatchObject({
      schema: 'hercules-artifact-export-receipt/v1',
      bundleName: 'bundle-1',
      anchorCount: 3,
      blobCount: 1,
    });
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-1')).resolves.toMatchObject({
      bundleName: 'bundle-1',
      limitation: 'internally_consistent_not_authenticity_signed',
    });
    await expect(archive.exportSnapshot('bundle-1')).rejects.toMatchObject({ code: 'conflict' });
    await archive.exportSnapshot('bundle-database-tampered');
    await archive.exportSnapshot('bundle-inventory-omits-blob');
    await archive.exportSnapshot('bundle-inventory-extra-blob');
    await archive.exportSnapshot('bundle-inventory-wrong-length');
    await archive.exportSnapshot('bundle-inventory-wrong-digest');
    await archive.close();

    const extraBlobBundleRoot = join(target.exportRoot, 'bundle-inventory-extra-blob');
    const extraBlobBytes = Buffer.from('not retained by the exported metadata snapshot');
    const extraBlobDigest =
      `sha256:${createHash('sha256').update(extraBlobBytes).digest('hex')}`;
    const extraBlobHex = extraBlobDigest.slice('sha256:'.length);
    const extraBlobPath = join(
      'content', 'sha256', extraBlobHex.slice(0, 2), extraBlobHex.slice(2, 4), extraBlobHex,
    );
    await mkdir(dirname(join(extraBlobBundleRoot, extraBlobPath)), { recursive: true, mode: 0o700 });
    await writeFile(join(extraBlobBundleRoot, extraBlobPath), extraBlobBytes, { mode: 0o600 });
    await rewriteExportInventory(extraBlobBundleRoot, (inventory) => {
      inventory.blobs.push({
        path: extraBlobPath,
        sha256: extraBlobDigest,
        byteLength: extraBlobBytes.byteLength,
      });
      inventory.blobs.sort((left, right) => left.sha256.localeCompare(right.sha256));
    });
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-inventory-extra-blob')).rejects
      .toMatchObject({ code: 'integrity' });

    const wrongLengthBundleRoot = join(target.exportRoot, 'bundle-inventory-wrong-length');
    await rewriteExportInventory(wrongLengthBundleRoot, (inventory) => {
      inventory.blobs[0]!.byteLength += 1;
    });
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-inventory-wrong-length')).rejects
      .toMatchObject({ code: 'integrity' });

    const wrongDigestBundleRoot = join(target.exportRoot, 'bundle-inventory-wrong-digest');
    await rewriteExportInventory(wrongDigestBundleRoot, (inventory) => {
      inventory.blobs[0]!.sha256 = `sha256:${'f'.repeat(64)}`;
    });
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-inventory-wrong-digest')).rejects
      .toMatchObject({ code: 'integrity' });

    const missingBlobBundleRoot = join(target.exportRoot, 'bundle-inventory-omits-blob');
    const missingBlobInventoryPath = join(missingBlobBundleRoot, 'inventory.json');
    const missingBlobInventory = JSON.parse(await readFile(missingBlobInventoryPath, 'utf8')) as {
      blobs: unknown[];
    };
    expect(missingBlobInventory.blobs).toHaveLength(1);
    missingBlobInventory.blobs = [];
    const missingBlobInventoryText = canonicalSerialize(missingBlobInventory);
    await writeFile(missingBlobInventoryPath, missingBlobInventoryText);
    await rm(join(missingBlobBundleRoot, 'content', 'sha256'), { recursive: true });
    await mkdir(join(missingBlobBundleRoot, 'content', 'sha256'), { mode: 0o700 });
    const missingBlobCompletePath = join(missingBlobBundleRoot, '.complete');
    const missingBlobComplete = JSON.parse(await readFile(missingBlobCompletePath, 'utf8')) as {
      inventorySha256: string;
    };
    missingBlobComplete.inventorySha256 =
      `sha256:${createHash('sha256').update(missingBlobInventoryText).digest('hex')}`;
    await writeFile(missingBlobCompletePath, canonicalSerialize(missingBlobComplete));
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-inventory-omits-blob')).rejects
      .toMatchObject({ code: 'integrity' });

    const tamperedBundleRoot = join(target.exportRoot, 'bundle-database-tampered');
    const tamperedDatabasePath = join(tamperedBundleRoot, 'database.sqlite');
    const tamperedDatabase = new Database(tamperedDatabasePath);
    tamperedDatabase.exec('DROP TRIGGER artifact_refs_no_update');
    tamperedDatabase.prepare('UPDATE artifact_refs SET media_type = ?').run('application/json');
    tamperedDatabase.close();
    const tamperedDatabaseBytes = await readFile(tamperedDatabasePath);
    const tamperedInventoryPath = join(tamperedBundleRoot, 'inventory.json');
    const tamperedInventory = JSON.parse(await readFile(tamperedInventoryPath, 'utf8')) as {
      database: { sha256: string; byteLength: number };
    };
    tamperedInventory.database.sha256 =
      `sha256:${createHash('sha256').update(tamperedDatabaseBytes).digest('hex')}`;
    tamperedInventory.database.byteLength = tamperedDatabaseBytes.byteLength;
    const tamperedInventoryText = canonicalSerialize(tamperedInventory);
    await writeFile(tamperedInventoryPath, tamperedInventoryText);
    const tamperedCompletePath = join(tamperedBundleRoot, '.complete');
    const tamperedComplete = JSON.parse(await readFile(tamperedCompletePath, 'utf8')) as {
      inventorySha256: string;
    };
    tamperedComplete.inventorySha256 =
      `sha256:${createHash('sha256').update(tamperedInventoryText).digest('hex')}`;
    await writeFile(tamperedCompletePath, canonicalSerialize(tamperedComplete));
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-database-tampered')).rejects
      .toMatchObject({ code: 'integrity' });

    const inventoryPath = join(bundleRoot, 'inventory.json');
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as {
      anchors: Array<{ path: string }>;
    };
    inventory.anchors[0]!.path = '../../database.sqlite';
    const inventoryText = canonicalSerialize(inventory);
    await writeFile(inventoryPath, inventoryText);
    const completePath = join(bundleRoot, '.complete');
    const complete = JSON.parse(await readFile(completePath, 'utf8')) as {
      inventorySha256: string;
    };
    complete.inventorySha256 = `sha256:${createHash('sha256').update(inventoryText).digest('hex')}`;
    await writeFile(completePath, canonicalSerialize(complete));
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-1')).rejects.toMatchObject({
      code: 'integrity',
    });

    const reopened = await openArtifactEvidenceArchive(options(target, () => now));
    await expect(reopened.verifyExportSnapshot('bundle-1')).rejects.toMatchObject({
      code: 'integrity',
    });
    await expect(reopened.verifyAll()).resolves.toMatchObject({ anchorCount: 3 });
    await reopened.close();
    now = '2026-08-10T00:00:00.000Z';
    const manifestProtected = await openArtifactEvidenceArchive(options(target, () => now, 1));
    await expect(manifestProtected.verifyAll()).resolves.toMatchObject({
      anchorCount: 3,
      verifiedBlobCount: 1,
    });
    await manifestProtected.close();
  });

  it('fails closed on partial residue and a recomputed malformed owner marker', async () => {
    const target = await fixture();
    seedState(target);
    const archive = await openArtifactEvidenceArchive(
      options(target, () => '2026-08-01T00:04:00.000Z'),
    );
    await archive.exportSnapshot('bundle-partial');
    await archive.exportSnapshot('bundle-owner-tampered');
    await archive.exportSnapshot('bundle-stale');
    await archive.close();

    const partialRoot = join(target.exportRoot, 'bundle-partial');
    await unlink(join(partialRoot, '.complete'));
    await unlink(join(partialRoot, 'inventory.json'));
    await unlink(join(target.exportRoot, 'bundle-stale', '.complete'));
    const reopened = await openArtifactEvidenceArchive(
      options(target, () => '2026-08-01T00:05:00.000Z'),
    );
    await expect(reopened.exportSnapshot('bundle-partial')).rejects.toMatchObject({
      code: 'integrity',
    });
    await expect(reopened.verifyAll()).resolves.toMatchObject({ anchorCount: 0 });
    await reopened.issueCaptureAuthorization({
      id: 'authorization-after-export-failure',
      artifactRefId: 'artifact-after-export-failure',
      idempotencyKey: 'issue-after-export-failure',
      mediaType: 'text/plain; charset=utf-8',
      maximumByteLength: 4096,
      accessClass: 'operator',
    }, authority());
    await expect(reopened.exportSnapshot('bundle-stale')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(lstat(join(target.exportRoot, 'bundle-stale', '.complete'))).rejects
      .toMatchObject({ code: 'ENOENT' });
    await expect(reopened.verifyAll()).resolves.toMatchObject({ anchorCount: 1 });
    await reopened.close();

    const ownerTamperedRoot = join(target.exportRoot, 'bundle-owner-tampered');
    const ownerPath = join(ownerTamperedRoot, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { nonce: string };
    owner.nonce = 'not-a-uuid';
    const ownerText = canonicalSerialize(owner);
    await writeFile(ownerPath, ownerText);
    const ownerCompletePath = join(ownerTamperedRoot, '.complete');
    const ownerComplete = JSON.parse(await readFile(ownerCompletePath, 'utf8')) as {
      ownerSha256: string;
    };
    ownerComplete.ownerSha256 = `sha256:${createHash('sha256').update(ownerText).digest('hex')}`;
    await writeFile(ownerCompletePath, canonicalSerialize(ownerComplete));
    await expect(verifyArtifactExport(target.exportRoot, 'bundle-owner-tampered')).rejects
      .toMatchObject({ code: 'integrity' });
  });

  it('rejects hostile export roots, directories, files, links, and unknown entries', async () => {
    const target = await fixture();
    seedState(target);
    const bundleNames = [
      'permissive-directory',
      'permissive-file',
      'hard-linked-file',
      'symlinked-file',
      'special-file',
      'unexpected-entry',
      'wrong-owner',
    ] as const;
    const archive = await openArtifactEvidenceArchive(
      options(target, () => '2026-08-01T00:04:00.000Z'),
    );
    for (const bundleName of bundleNames) await archive.exportSnapshot(bundleName);
    await archive.close();

    await chmod(join(target.exportRoot, 'permissive-directory'), 0o755);
    await expect(verifyArtifactExport(target.exportRoot, 'permissive-directory')).rejects
      .toMatchObject({ code: 'unsafe_path' });

    await chmod(join(target.exportRoot, 'permissive-file', 'owner.json'), 0o644);
    await expect(verifyArtifactExport(target.exportRoot, 'permissive-file')).rejects
      .toMatchObject({ code: 'integrity' });

    const hardLinkedOwner = join(target.exportRoot, 'hard-linked-file', 'owner.json');
    await link(hardLinkedOwner, join(target.parent, 'owner-hardlink'));
    await expect(verifyArtifactExport(target.exportRoot, 'hard-linked-file')).rejects
      .toMatchObject({ code: 'integrity' });

    const symlinkedOwner = join(target.exportRoot, 'symlinked-file', 'owner.json');
    const externalOwner = join(target.parent, 'external-owner.json');
    await copyFile(symlinkedOwner, externalOwner);
    await unlink(symlinkedOwner);
    await symlink(externalOwner, symlinkedOwner);
    await expect(verifyArtifactExport(target.exportRoot, 'symlinked-file')).rejects
      .toMatchObject({ code: 'integrity' });

    const specialOwner = join(target.exportRoot, 'special-file', 'owner.json');
    await unlink(specialOwner);
    await execFileAsync('mkfifo', [specialOwner]);
    await expect(verifyArtifactExport(target.exportRoot, 'special-file')).rejects
      .toMatchObject({ code: 'integrity' });

    await writeFile(join(target.exportRoot, 'unexpected-entry', 'unknown'), 'unexpected');
    await expect(verifyArtifactExport(target.exportRoot, 'unexpected-entry')).rejects
      .toMatchObject({ code: 'integrity' });

    const currentUid = process.getuid?.();
    expect(currentUid).toBeTypeOf('number');
    if (currentUid === undefined) throw new Error('test requires process.getuid');
    const getuid = vi
      .spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid')
      .mockReturnValue(currentUid + 1);
    try {
      await expect(verifyArtifactExport(target.exportRoot, 'wrong-owner')).rejects
        .toMatchObject({ code: 'unsafe_path' });
    } finally {
      getuid.mockRestore();
    }

    const aliasRoot = join(target.parent, 'export-root-alias');
    await symlink(target.exportRoot, aliasRoot, 'dir');
    await expect(verifyArtifactExport(aliasRoot, 'wrong-owner')).rejects
      .toMatchObject({ code: 'unsafe_path' });

    await chmod(target.exportRoot, 0o755);
    await expect(verifyArtifactExport(target.exportRoot, 'wrong-owner')).rejects
      .toMatchObject({ code: 'unsafe_path' });
  });

  it('rejects concurrent entry and retires only after candidate protection expires', async () => {
    const target = await fixture();
    seedState(target);
    let now = '2026-08-01T00:04:00.000Z';
    const archive = await openArtifactEvidenceArchive(options(target, () => now));
    const first = archive.issueCaptureAuthorization({
      id: 'authorization-busy-1',
      artifactRefId: 'artifact-1',
      idempotencyKey: 'issue-busy-1',
      mediaType: 'text/plain; charset=utf-8',
      maximumByteLength: 4096,
      accessClass: 'operator',
    }, authority());
    await expect(archive.verifyAll()).rejects.toBeInstanceOf(ArtifactEvidenceArchiveError);
    await first;

    now = '2026-08-01T00:05:00.000Z';
    const artifact = await capture(
      archive,
      'artifact-2',
      'authorization-2',
      Buffer.from('retained until protection expires'),
    );
    now = '2026-08-10T00:00:00.000Z';
    const retirement = await archive.retireArtifact({
      id: 'retirement-2',
      idempotencyKey: 'retire-artifact-2',
      artifactRefId: artifact.id,
      reason: 'retention-window-ended',
      policyCutoff: '2026-08-02T00:00:00.000Z',
    });
    expect(retirement.artifactRefId).toBe(artifact.id);
    await expect(archive.verifyAll()).resolves.toMatchObject({ verifiedBlobCount: 0 });
    await archive.close();
  });

  it('serializes every coordinator operation, excludes peer opens, and drains close', async () => {
    const target = await fixture();
    const criterionId = seedState(target);
    let now = '2026-08-01T00:04:00.000Z';
    const archive = await openArtifactEvidenceArchive(options(target, () => now));
    await expect(openArtifactEvidenceArchive(options(target, () => now))).rejects.toMatchObject({
      code: 'archive_lock_busy',
    });

    const expectPeerBusy = async <T>(operation: Promise<T>): Promise<T> => {
      await expect(archive.verifyAll()).rejects.toMatchObject({ code: 'busy' });
      return operation;
    };
    await expectPeerBusy(archive.issueCaptureAuthorization({
      id: 'authorization-matrix-1',
      artifactRefId: 'artifact-1',
      idempotencyKey: 'issue-matrix-1',
      mediaType: 'text/plain; charset=utf-8',
      maximumByteLength: 4096,
      accessClass: 'operator',
    }, authority()));
    const bytes = Buffer.from('operation matrix artifact');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const observation = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueCaptureObservation({
      authorizationId: 'authorization-matrix-1',
      sha256: digest,
      byteLength: bytes.byteLength,
      redactionState: 'redacted',
      accessClass: 'operator',
      observedAt: '2026-08-01T00:04:30.000Z',
    });
    now = '2026-08-01T00:05:00.000Z';
    const artifact = await expectPeerBusy(archive.recordArtifact({
      authorizationId: 'authorization-matrix-1',
      observation,
      mediaType: 'text/plain; charset=utf-8',
      bytes,
    }));
    const access = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArtifactAccess({
      sha256: artifact.sha256,
      purpose: 'read',
      authorizationClass: 'operator',
      issuer: 'trusted-operator',
      issuedAt: '2026-08-01T00:05:00.000Z',
      expiresAt: '2026-08-01T00:07:00.000Z',
    });
    await expectPeerBusy(archive.readArtifact(artifact.id, access));

    now = '2026-08-01T00:06:00.000Z';
    const manifest = await expectPeerBusy(archive.recordManifest({
      id: 'manifest-matrix-1',
      idempotencyKey: 'manifest-matrix-1',
      taskId: 'task-1',
      contractVersion: 1,
      iterationId: 'iteration-1',
      entries: [{ artifactRefId: artifact.id, criterionIds: [criterionId] }],
    }));
    await expectPeerBusy(archive.readManifest(manifest.id));
    await expectPeerBusy(archive.exportSnapshot('bundle-operation-matrix'));
    await expectPeerBusy(archive.verifyExportSnapshot('bundle-operation-matrix'));
    await expectPeerBusy(archive.verifyAll());

    const activeVerification = archive.verifyAll();
    const closing = archive.close();
    await expect(archive.readManifest(manifest.id)).rejects.toMatchObject({ code: 'closed' });
    await activeVerification;
    await closing;
    await expect(archive.close()).resolves.toBeUndefined();
    await expect(archive.verifyAll()).rejects.toMatchObject({ code: 'closed' });

    const reopened = await openArtifactEvidenceArchive(options(target, () => now));
    await expect(reopened.verifyAll()).resolves.toMatchObject({ verifiedBlobCount: 1 });
    await reopened.close();
  });

  it('owns factory options before its first await and releases a failed initialization lease', async () => {
    const target = await fixture();
    seedState(target);
    const overlappingOptions = options(target, () => '2026-08-01T00:04:00.000Z');
    (overlappingOptions as unknown as Record<string, unknown>)['exportRoot'] = target.controlRoot;
    await expect(openArtifactEvidenceArchive(overlappingOptions)).rejects.toMatchObject({
      code: 'invalid_schema',
    });

    await mkdir(target.exportRoot, { mode: 0o700 });
    const exportAlias = join(target.parent, 'export-alias');
    await symlink(target.exportRoot, exportAlias, 'dir');
    const canonicalOverlapOptions = options(target, () => '2026-08-01T00:04:00.000Z');
    (canonicalOverlapOptions as unknown as { providerWorkRoots: string[] }).providerWorkRoots = [
      join(exportAlias, 'prospective-provider'),
    ];
    await expect(openArtifactEvidenceArchive(canonicalOverlapOptions)).rejects.toMatchObject({
      code: 'artifact_integrity',
      reason: 'root_overlap',
    });

    const mutableOptions = options(target, () => '2026-08-01T00:04:00.000Z');
    const opening = openArtifactEvidenceArchive(mutableOptions);
    const mutableRecord = mutableOptions as unknown as Record<string, unknown>;
    mutableRecord['artifactRoot'] = join(target.parent, 'mutated-artifacts');
    (mutableRecord['providerWorkRoots'] as string[])[0] = target.artifactRoot;
    (mutableRecord['policy'] as Record<string, unknown>)['maximumArtifactBytes'] = 0;
    mutableRecord['clock'] = () => {
      throw new Error('mutated clock must not be retained');
    };
    const archive = await opening;
    await expect(archive.verifyAll()).resolves.toMatchObject({ anchorCount: 0 });
    await archive.close();
    await expect(lstat(join(target.parent, 'mutated-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const failedTarget = await fixture();
    await mkdir(failedTarget.stateRoot, { mode: 0o700 });
    await writeFile(failedTarget.databasePath, 'not a SQLite database', { mode: 0o600 });
    await expect(openArtifactEvidenceArchive(
      options(failedTarget, () => '2026-08-01T00:04:00.000Z'),
    )).rejects.toBeDefined();
    await unlink(failedTarget.databasePath);
    const recovered = await openArtifactEvidenceArchive(
      options(failedTarget, () => '2026-08-01T00:04:00.000Z'),
    );
    await expect(recovered.verifyAll()).resolves.toMatchObject({ anchorCount: 0 });
    await recovered.close();
  });

  it('rejects secret-shaped durable metadata before mutation', async () => {
    const target = await fixture();
    seedState(target);
    let now = '2026-08-01T00:04:00.000Z';
    const archive = await openArtifactEvidenceArchive(
      options(target, () => now),
    );
    await expect(archive.issueCaptureAuthorization({
      id: 'authorization-secret-metadata',
      artifactRefId: 'artifact-1',
      idempotencyKey: 'issue-secret-metadata',
      mediaType: 'text/plain; charset=utf-8',
      maximumByteLength: 4096,
      accessClass: 'operator',
    }, authority('api_key=synthetic-metadata-secret'))).rejects.toMatchObject({
      code: 'artifact_secret',
    });
    await expect(archive.verifyAll()).resolves.toMatchObject({ anchorCount: 0 });
    now = '2026-08-01T00:05:00.000Z';
    const artifact = await capture(
      archive,
      'artifact-2',
      'authorization-clean-metadata',
      Buffer.from('clean metadata content'),
    );
    await expect(archive.retireArtifact({
      id: 'retirement-secret-metadata',
      idempotencyKey: 'retire-secret-metadata',
      artifactRefId: artifact.id,
      reason: 'password=synthetic-retirement-secret',
      policyCutoff: '2026-08-01T00:05:00.000Z',
    })).rejects.toMatchObject({ code: 'artifact_secret' });
    await expect(archive.verifyAll()).resolves.toMatchObject({ anchorCount: 2 });
    await archive.close();
  });

  it('recovers an anchor temp left after the final hard link was installed', async () => {
    const target = await fixture();
    seedState(target);
    const first = await openArtifactEvidenceArchive(
      options(target, () => '2026-08-01T00:04:00.000Z'),
    );
    await first.issueCaptureAuthorization({
      id: 'authorization-linked-anchor-temp',
      artifactRefId: 'artifact-1',
      idempotencyKey: 'issue-linked-anchor-temp',
      mediaType: 'text/plain; charset=utf-8',
      maximumByteLength: 4096,
      accessClass: 'operator',
    }, authority());
    await first.close();

    const anchorsRoot = join(target.artifactRoot, 'anchors');
    const anchorNames = await readdir(anchorsRoot);
    expect(anchorNames).toHaveLength(1);
    const tempPath = join(target.artifactRoot, '.tmp', `anchor-${randomUUID()}.tmp`);
    await link(join(anchorsRoot, anchorNames[0]!), tempPath);
    expect((await lstat(tempPath)).nlink).toBe(2);

    const reopened = await openArtifactEvidenceArchive(
      options(target, () => '2026-08-01T00:05:00.000Z'),
    );
    await expect(lstat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(reopened.verifyAll()).resolves.toMatchObject({ anchorCount: 1 });
    await reopened.close();
  });

  it('applies finite retention on startup and resumes a proven retired unlink', async () => {
    const target = await fixture();
    seedState(target);
    let now = '2026-08-01T00:04:00.000Z';
    const first = await openArtifactEvidenceArchive(options(target, () => now));
    now = '2026-08-01T00:05:00.000Z';
    const bytes = Buffer.from('finite retention payload');
    const artifact = await capture(first, 'artifact-2', 'authorization-retention', bytes);
    await first.close();

    now = '2026-08-10T00:00:00.000Z';
    const retained = await openArtifactEvidenceArchive(options(target, () => now, 1));
    await expect(retained.verifyAll()).resolves.toMatchObject({
      anchorCount: 3,
      verifiedBlobCount: 0,
    });
    await retained.close();

    const contentPath = join(target.artifactRoot, artifact.storageKey);
    await writeFile(contentPath, bytes, { mode: 0o600, flag: 'wx' });
    const recovered = await openArtifactEvidenceArchive(options(target, () => now, 1));
    await expect(lstat(contentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(recovered.verifyAll()).resolves.toMatchObject({ verifiedBlobCount: 0 });
    await recovered.close();
  });
});
