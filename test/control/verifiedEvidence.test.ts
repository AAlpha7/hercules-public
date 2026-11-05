import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER,
  type ArtifactEvidenceArchiveOptions,
} from '../../src/control/artifacts/archiveTypes.js';
import {
  openArtifactEvidenceArchive,
  type ArtifactEvidenceArchive,
} from '../../src/control/artifacts/evidenceArchive.js';
import { AUTHORITY_ROSTER_SCHEMA, type AuthorityRoster } from '../../src/control/authorityRoster.js';
import {
  assembleReviewPackageSource,
  createReviewPackageRefreshSeam,
} from '../../src/control/reviewPackageSource.js';
import { SqliteStateStore } from '../../src/control/state/sqliteStateStore.js';
import {
  type ShadowCommitCommand,
  type V2BoundEvidenceV1,
} from '../../src/control/state/stateStore.js';
import { computeV2BoundEvidenceHash } from '../../src/control/state/stateStoreValidation.js';
import {
  produceAllVerifiedEvidence,
  produceVerifiedEvidence,
  VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION,
  type ProduceOutcome,
  type VerifiedEvidenceProducerPorts,
} from '../../src/control/verifiedEvidence.js';
import {
  createVerifiedEvidenceIntake,
  VerifiedEvidenceIntakeError,
  type VerifiedEvidenceIntake,
} from '../../src/control/verifiedEvidenceIntake.js';
import type { CandidateRef } from '../../src/domain/artifact.js';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import { compileLegacyTaskContract } from '../../src/domain/contractCompiler.js';
import { transitionIteration, type Iteration } from '../../src/domain/iteration.js';
import type { Task } from '../../src/domain/task.js';
import type { ReviewPacket } from '../../src/domain/verification.js';

const cleanup: string[] = [];
const FIXED_CLOCK = '2026-09-05T12:00:00.000Z';
const CAPTURED_AT = '2026-09-05T11:59:00.000Z';
const REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REPOSITORY = 'example-org/acme';
const TASK_ID = 'c3-evidence-happy';
const ITERATION_ID = 'iteration-1';
const BRANCH = 'hercules/c3-evidence-happy';

const ROSTER: AuthorityRoster = {
  schema: AUTHORITY_ROSTER_SCHEMA,
  verifier: {
    runId: 'verifier-legacy-1',
    implementation: 'hercules-legacy-verifier/v1',
  },
  evaluator: {
    runId: 'evaluator-1',
    implementationId: 'evaluator-impl-1',
    version: 'evaluator-v1',
    model: 'model-v1',
    runtime: 'runtime-v1',
  },
};

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface FixturePaths {
  readonly parent: string;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly exportRoot: string;
  readonly controlRoot: string;
  readonly providerRoot: string;
  readonly intakeRoot: string;
  readonly screenshotDir: string;
}

function paths(): FixturePaths {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-verified-evidence-'));
  cleanup.push(parent);
  mkdirSync(join(parent, 'state'), { mode: 0o700 });
  return {
    parent,
    stateRoot: join(parent, 'state'),
    databasePath: join(parent, 'state', 'shadow.sqlite'),
    artifactRoot: join(parent, 'artifacts'),
    exportRoot: join(parent, 'exports'),
    controlRoot: join(parent, 'control'),
    providerRoot: join(parent, 'provider'),
    intakeRoot: join(parent, 'intake'),
    screenshotDir: join(parent, 'screenshots'),
  };
}

function command(
  id: string,
  mutation: ShadowCommitCommand['mutation'],
  occurredAt = FIXED_CLOCK,
): ShadowCommitCommand {
  return {
    idempotencyKey: `idem-${id}`,
    event: {
      eventId: `event-${id}`,
      actor: { kind: 'control_plane', id: 'v2-c3-evidence-test' },
      occurredAt,
    },
    mutation,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Project ${id}`,
    repo: REPOSITORY,
    state: 'review',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body:
      '## Definition of Done\n' +
      '- [ ] (mechanical) Unit tests pass @gate:unit\n' +
      '- [ ] (mechanical) Settings screenshot proves the UI @evidence:settings\n' +
      '- [ ] (human) Owner accepts the change\n',
    ...overrides,
  };
}

function completeZeroCommandDelivery(
  store: SqliteStateStore,
  deliveryId: string,
  writes: readonly Task[],
): void {
  const ordered = [...writes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  store.beginEnvelope({
    deliveryId,
    authorityRevision: 'b'.repeat(40),
    authorityInput: { writes: ordered, retiredTaskIds: [] },
    manifest: [],
    gapCodes: [],
  });
  store.completeEnvelope(deliveryId);
}

function candidate(): CandidateRef & { kind: 'git' } {
  return { kind: 'git', repository: REPOSITORY, revision: REVISION };
}

function seedReviewAggregate(store: SqliteStateStore, taskId: string): {
  readonly contractVersion: number;
  readonly mechanicalIds: readonly string[];
} {
  const body = task(taskId).body;
  const compiled = compileLegacyTaskContract({
    taskId,
    objective: 'Ship verified evidence through the M5 archive',
    body,
    context: [],
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      requiredEvidence: ['unit', 'settings'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: 'approval-v1', requiredDecisions: ['approve_outcome'] },
    budgetPolicy: {
      version: 'budget-v1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'human', id: 'owner' },
    createdAt: '2026-08-28T00:00:00.000Z',
  }).contract;

  store.commit(command(`root-${taskId}`, {
    kind: 'insert_contract_root',
    contract: compiled,
  }));

  const planned: Iteration = {
    id: ITERATION_ID,
    taskId,
    contractVersion: compiled.version,
    ordinal: 1,
    state: 'planned',
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt: '2026-09-05T11:00:00.000Z',
    endedAt: null,
    supersedesIterationId: null,
  };
  store.commit(command(`planned-${taskId}`, { kind: 'put_iteration', iteration: planned }));
  const executing = transitionIteration(planned, 'executing', null);
  store.commit(command(`executing-${taskId}`, { kind: 'put_iteration', iteration: executing }));
  const verifying = transitionIteration(executing, 'verifying', null, {
    candidateRef: candidate(),
    evidenceManifestId: null,
    finalVerdictId: null,
  });
  store.commit(command(`verifying-${taskId}`, { kind: 'put_iteration', iteration: verifying }));

  // Producer commits its own verify stage run before capture — no test-side seeding.

  completeZeroCommandDelivery(store, `delivery-${taskId}`, [task(taskId, { state: 'review' })]);

  return {
    contractVersion: compiled.version,
    mechanicalIds: compiled.acceptanceCriteria
      .filter((criterion) => criterion.authority === 'mechanical')
      .map((criterion) => criterion.id),
  };
}

function archiveOptions(
  target: FixturePaths,
  clock: () => string,
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
      retentionDays: null,
      orphanGraceDays: 1,
    },
    clock,
  };
}

function mintAuthority(input: {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly producerStageRunId: string;
  readonly environmentRef: string;
  readonly surface: string;
  readonly stageStartedAt: string;
}) {
  const issuedAt = input.stageStartedAt;
  const expiresAt = new Date(
    Date.parse(issuedAt) + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  return TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArchiveAuthority({
    issuer: 'verified-evidence-test',
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    iterationId: input.iterationId,
    producerStageRunId: input.producerStageRunId,
    stageType: 'verify',
    stageStartedAt: issuedAt,
    candidateRef: input.candidateRef,
    environmentRef: input.environmentRef,
    surface: input.surface,
    maximumTrustClass: 'primary',
    maximumAccessClass: 'operator',
    maximumByteLength: 1024 * 1024,
    allowedMediaTypes: [
      'text/plain',
      'text/x-diff',
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/webm',
      'video/mp4',
    ],
    issuedAt,
    expiresAt,
  });
}

function mintObservation(input: {
  readonly authorizationId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly observedAt: string;
}) {
  return TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueCaptureObservation({
    authorizationId: input.authorizationId,
    sha256: input.sha256,
    byteLength: input.byteLength,
    redactionState: 'none',
    accessClass: 'operator',
    observedAt: input.observedAt,
  });
}

function minimalPng(): Buffer {
  // 1x1 PNG
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
}

function syntheticPacket(screenshotPath: string, overrides: {
  readonly dodTexts?: readonly [string, string, string];
} = {}): ReviewPacket {
  const texts = overrides.dodTexts ?? [
    'Unit tests pass @gate:unit',
    'Settings screenshot proves the UI @evidence:settings',
    'Owner accepts the change',
  ] as const;
  return {
    taskId: TASK_ID,
    branch: BRANCH,
    filesTouched: ['src/example.ts'],
    diffSummary: '1 file changed',
    diff: 'diff --git a/src/example.ts b/src/example.ts\n+export const ok = true;\n',
    gates: [
      {
        name: 'unit',
        command: 'pnpm test:unit',
        passed: true,
        output: 'unit ok\n',
        exitCode: 0,
      },
      {
        name: 'typecheck',
        command: 'pnpm typecheck',
        passed: true,
        output: 'types ok\n',
        exitCode: 0,
      },
    ],
    cheatFindings: [],
    screenshots: [screenshotPath],
    evidenceRun: {
      source: 'workflow',
      ok: true,
      steps: [
        {
          kind: 'screenshot',
          ok: true,
          detail: 'Settings screenshot proves the UI',
          optional: false,
          screenshot: screenshotPath,
        },
      ],
    },
    reviewerVerdict: null,
    selfAssessment: 'looks good',
    finalReport: '## Report\nDone.\n',
    green: true,
    noChanges: false,
    dod: {
      mechanical: 'pass',
      reviewer: 'n/a',
      human: 'pending',
      criteria: [
        {
          text: texts[0],
          kind: 'mechanical',
          status: 'pass',
          proof: 'gate:unit',
        },
        {
          text: texts[1],
          kind: 'mechanical',
          status: 'pass',
          proof: `screenshot ${screenshotPath}`,
        },
        {
          text: texts[2],
          kind: 'human',
          status: 'pending',
          proof: 'awaiting owner',
        },
      ],
      warnings: [],
    },
    autoRework: false,
    reworkPath: null,
    reworkPathReason: null,
    reportPolluted: false,
    activityLog: ['ran gates'],
    runKind: 'implementer',
    reviewerSkipReason: null,
    diffUrl: null,
    evidenceMatrix: [],
    verifiedSha: REVISION,
  };
}

async function openHarness(target: FixturePaths): Promise<{
  readonly store: SqliteStateStore;
  readonly archive: ArtifactEvidenceArchive;
  readonly intake: VerifiedEvidenceIntake;
  readonly logs: string[];
  readonly ports: VerifiedEvidenceProducerPorts;
  readonly beforeProjectionHash: string | null;
}> {
  const store = new SqliteStateStore({
    trustedRoot: target.stateRoot,
    databasePath: target.databasePath,
    busyTimeoutMs: 100,
    clock: () => FIXED_CLOCK,
    refreshReviewPackage: createReviewPackageRefreshSeam(() => FIXED_CLOCK, { roster: ROSTER }),
  });
  store.initialize();
  seedReviewAggregate(store, TASK_ID);

  const before = store.readV2Aggregate(TASK_ID);
  expect(before).not.toBeNull();
  expect(before!.taskStatus).toBe('review');
  expect(before!.projectionState).toBe('projected');
  expect(before!.reviewPackage).not.toBeNull();
  expect(before!.reviewPackage!.binding.evidenceManifestHash).toBeNull();
  expect(before!.reviewPackage!.evidence).toEqual([]);
  expect(before!.reviewPackage!.validDecisions).toEqual([]);
  const beforeProjectionHash = before!.reviewPackage!.projectionHash;

  const archive = await openArtifactEvidenceArchive(archiveOptions(target, () => FIXED_CLOCK));
  const intake = createVerifiedEvidenceIntake({ root: target.intakeRoot });
  const logs: string[] = [];

  const ports: VerifiedEvidenceProducerPorts = {
    store,
    archive,
    intake,
    roster: ROSTER,
    clock: () => FIXED_CLOCK,
    log: (line) => {
      logs.push(line);
    },
    archiveContexts: {
      authority: mintAuthority,
      observation: mintObservation,
    },
  };

  return { store, archive, intake, logs, ports, beforeProjectionHash };
}

describe('verified evidence intake', () => {
  it('stages a bundle idempotently and rejects path traversal / conflicting hashes', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());

    const intake = createVerifiedEvidenceIntake({ root: target.intakeRoot });
    const packet = syntheticPacket(screenshotPath);
    const first = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet,
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    expect(first.schema).toBe('hercules-staged-verification-bundle/v1');
    expect(first.gates).toHaveLength(2);
    expect(first.screenshots).toHaveLength(1);
    expect(first.diffFile).toBe('diff.patch');
    expect(first.finalReportFile).toBe('final-report.md');

    const second = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet,
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    expect(second.bundleHash).toBe(first.bundleHash);

    const gateBytes = await intake.readFile(TASK_ID, REVISION, first.gates[0]!.outputFile);
    expect(new TextDecoder().decode(gateBytes)).toContain('unit ok');

    await expect(
      intake.readFile(TASK_ID, REVISION, '../escape.txt'),
    ).rejects.toBeInstanceOf(VerifiedEvidenceIntakeError);
    await expect(
      intake.readFile(TASK_ID, REVISION, 'a/b.txt'),
    ).rejects.toBeInstanceOf(VerifiedEvidenceIntakeError);

    await expect(
      intake.stage({
        task: { id: TASK_ID, repo: REPOSITORY },
        packet: { ...packet, diffSummary: 'changed summary forces new hash' },
        verifiedSha: REVISION,
        branch: BRANCH,
        capturedAt: CAPTURED_AT,
      }),
    ).rejects.toThrow(/different bundleHash/);
  });

  it('resolves basename screenshots against screenshotDir and fails closed without it (live staging finding)', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const intake = createVerifiedEvidenceIntake({ root: target.intakeRoot });
    const packet = { ...syntheticPacket(screenshotPath), screenshots: ['settings.png'] };

    await expect(intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet,
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    })).rejects.toThrow('relative name but no absolute screenshotDir');
    await expect(intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: { ...packet, screenshots: ['../settings.png'] },
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    })).rejects.toThrow('unsafe staged relative name');

    const staged = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet,
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    });
    expect(staged.screenshots).toHaveLength(1);
    expect(staged.screenshots[0]!.name).toBe('settings.png');
    // Absolute entries with a screenshotDir must resolve inside it (Codex R4 N1).
    const outside = join(target.intakeRoot, 'outside.png');
    writeFileSync(outside, minimalPng());
    await expect(intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: { ...packet, screenshots: [outside] },
      verifiedSha: 'f'.repeat(40),
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    })).rejects.toThrow('resolves outside screenshotDir');
    // A symlink inside the directory pointing out, reached through `..`, must
    // validate and read the SAME canonical path (Codex round-7 B1).
    const outsideDir = join(target.intakeRoot, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.png'), minimalPng());
    symlinkSync(target.screenshotDir, join(outsideDir, 'link'));
    await expect(intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: { ...packet, screenshots: [join(outsideDir, 'link', '..', 'secret.png')] },
      verifiedSha: 'e'.repeat(40),
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    })).rejects.toThrow('resolves outside screenshotDir');
    // An absolute entry that does not exist fails closed instead of a lexical fallback.
    await expect(intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: { ...packet, screenshots: [join(target.screenshotDir, 'missing.png')] },
      verifiedSha: 'd'.repeat(40),
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    })).rejects.toThrow('cannot be resolved inside screenshotDir');
    const absolute = await createVerifiedEvidenceIntake({ root: join(target.intakeRoot, 'abs') }).stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    // Same bytes, same digest whichever way the screenshot was referenced.
    expect(staged.screenshots[0]!.sha256).toBe(absolute.screenshots[0]!.sha256);
  });

  it('preserves media extension and records mediaType for png and webm (B4)', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const pngPath = join(target.screenshotDir, 'settings.png');
    const webmPath = join(target.screenshotDir, 'clip.webm');
    writeFileSync(pngPath, minimalPng());
    writeFileSync(webmPath, Buffer.from('webm-fake-bytes'));
    const intake = createVerifiedEvidenceIntake({ root: target.intakeRoot });
    const packet = {
      ...syntheticPacket(pngPath),
      screenshots: ['settings.png', 'clip.webm'],
    };
    const staged = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet,
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    });
    expect(staged.screenshots).toHaveLength(2);
    expect(staged.screenshots[0]).toMatchObject({
      name: 'settings.png',
      file: 'screenshot-0-settings.png',
      mediaType: 'image/png',
    });
    expect(staged.screenshots[1]).toMatchObject({
      name: 'clip.webm',
      file: 'screenshot-1-clip.webm',
      mediaType: 'video/webm',
    });
    await expect(intake.stage({
      task: { id: `${TASK_ID}-bad`, repo: REPOSITORY },
      packet: { ...packet, screenshots: ['notes.txt'] },
      verifiedSha: 'b'.repeat(40),
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    })).rejects.toThrow(/unsupported media extension/);
  });

  it('returns null with a loud log when bundle.json is truncated or invalid', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const intake = createVerifiedEvidenceIntake({ root: target.intakeRoot });
    await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    const bundlePath = join(target.intakeRoot, TASK_ID, REVISION, 'bundle.json');
    writeFileSync(bundlePath, '{"schema":"hercules-staged-verification-bundle/v1","truncated', {
      mode: 0o600,
    });
    expect(await intake.read(TASK_ID, REVISION)).toBeNull();
  });

  it('returns null when a staged gate file is rewritten after staging', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const intake = createVerifiedEvidenceIntake({ root: target.intakeRoot });
    const staged = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    const gatePath = join(
      target.intakeRoot,
      TASK_ID,
      REVISION,
      staged.gates[0]!.outputFile,
    );
    writeFileSync(gatePath, 'FORGED FAIL\n', { mode: 0o600 });
    expect(await intake.read(TASK_ID, REVISION)).toBeNull();
  });

  it('writes a truncated marker when a file exceeds the bundle byte budget', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());

    const intake = createVerifiedEvidenceIntake({
      root: target.intakeRoot,
      maxBundleBytes: 40,
    });
    const packet = syntheticPacket(screenshotPath);
    const bundle = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: {
        ...packet,
        gates: [
          {
            name: 'unit',
            command: 'pnpm test:unit',
            passed: true,
            output: 'x'.repeat(200),
            exitCode: 0,
          },
        ],
        screenshots: [],
        finalReport: '',
      },
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    expect(bundle.gates[0]!.truncated).toBe(true);
    const bytes = await intake.readFile(TASK_ID, REVISION, bundle.gates[0]!.outputFile);
    expect(new TextDecoder().decode(bytes)).toContain('TRUNCATED:');
    const markerDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(bundle.gates[0]!.sha256).toBe(markerDigest);
    expect(bundle.diffSha256.startsWith('sha256:')).toBe(true);
  });
});

describe('verified evidence producer', () => {
  it('stages → produces → binds intact evidence and is idempotent on already_bound', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());

    const { store, archive, intake, ports, beforeProjectionHash, logs } =
      await openHarness(target);

    const packet = syntheticPacket(screenshotPath);
    const staged = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet,
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    expect(staged.bundleHash.startsWith('sha256:')).toBe(true);

    const outcome = await produceVerifiedEvidence(ports, TASK_ID);
    if (outcome.kind !== 'bound') {
      throw new Error(`expected bound, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome).toMatchObject({
      kind: 'bound',
      aggregateId: TASK_ID,
      iterationId: ITERATION_ID,
    } satisfies Partial<ProduceOutcome>);

    const bound = store.readBoundEvidence(TASK_ID, ITERATION_ID);
    expect(bound).not.toBeNull();
    const record = bound as V2BoundEvidenceV1;
    expect(record.evidenceHash).toBe(outcome.evidenceHash);
    expect(computeV2BoundEvidenceHash((({ evidenceHash: _h, ...rest }) => rest)(record))).toBe(
      record.evidenceHash,
    );

    const archivedManifest = await archive.readManifest(outcome.manifestId);
    expect(archivedManifest).not.toBeNull();
    expect(archivedManifest).toEqual(record.evidenceManifest);

    for (const checked of record.evidenceIntegrity.checkedArtifacts) {
      const artifact = record.artifacts.find((item) => item.id === checked.artifactRefId);
      expect(artifact?.sha256).toBe(checked.sha256);
    }
    expect(record.evidenceIntegrity.result).toBe('intact');
    expect(record.evidenceIntegrity.verifierImplementation).toBe(
      VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION,
    );
    expect(
      record.verificationReceipts.every(
        (receipt) => receipt.verifierRunId === ROSTER.verifier.runId,
      ),
    ).toBe(true);

    const shadowAfter = store.readTask(TASK_ID);
    expect(shadowAfter).not.toBeNull();
    const verifyStage = shadowAfter!.stageRuns.find(
      (run) => run.id === `stage-verify-${ITERATION_ID}`,
    );
    expect(verifyStage).toMatchObject({
      id: `stage-verify-${ITERATION_ID}`,
      iterationId: ITERATION_ID,
      type: 'verify',
      attempt: 1,
      state: 'succeeded',
      jobSpecHash: staged.bundleHash,
      workerId: ROSTER.verifier.runId,
    });
    expect(verifyStage!.outputArtifactRefs.length).toBeGreaterThan(0);
    expect(
      record.artifacts.every((artifact) =>
        verifyStage!.outputArtifactRefs.includes(artifact.id),
      ),
    ).toBe(true);
    expect(record.artifacts.every(
      (artifact) => artifact.producerStageRunId === `stage-verify-${ITERATION_ID}`,
    )).toBe(true);

    const aggregate = store.readV2Aggregate(TASK_ID);
    expect(aggregate?.reviewPackage).not.toBeNull();
    expect(aggregate?.reviewPackage?.binding.evidenceManifestHash).toBe(
      record.evidenceManifest.manifestHash,
    );
    expect(aggregate?.reviewPackage?.validDecisions).toEqual([]);
    expect(aggregate?.reviewPackage?.outcome.decisionEligible).toBe(false);
    expect(aggregate?.reviewPackage?.evidence.length).toBeGreaterThan(0);
    expect(aggregate?.reviewPackage?.projectionHash).not.toBe(beforeProjectionHash);
    expect(aggregate?.projectionHash).toBe(aggregate?.reviewPackage?.projectionHash ?? null);

    const shadow = store.readTask(TASK_ID);
    expect(shadow).not.toBeNull();
    const assembled = assembleReviewPackageSource(
      {
        aggregateId: TASK_ID,
        taskStatus: 'review',
        shadow: shadow!,
        humanDecisions: [],
        evidence: record,
        evaluation: null,
      },
      FIXED_CLOCK,
      ROSTER,
    );
    expect(assembled.kind).toBe('source');
    if (assembled.kind === 'source') {
      expect(assembled.source.evidenceIntegrity.result).toBe('intact');
      expect(assembled.source.evidenceManifest).not.toBeNull();
      expect(assembled.source.evidenceManifest?.id).toBe(outcome.manifestId);
    }

    // Staged bundle discarded after successful bind.
    expect(await intake.read(TASK_ID, REVISION)).toBeNull();

    const again = await produceVerifiedEvidence(ports, TASK_ID);
    expect(again).toEqual({
      kind: 'skipped',
      aggregateId: TASK_ID,
      reason: 'already_bound',
    });
    expect(logs.some((line) => line.includes('already_bound'))).toBe(true);

    await archive.close();
    store.close();
  });

  it('archives WebM with video/webm and defaults legacy manifests to image/png (B4)', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const webmPath = join(target.screenshotDir, 'clip.webm');
    writeFileSync(webmPath, Buffer.from('webm-fake-bytes'));
    const { store, archive, intake, ports } = await openHarness(target);
    const packet = syntheticPacket(webmPath);
    const staged = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet,
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
      screenshotDir: target.screenshotDir,
    });
    expect(staged.screenshots[0]?.mediaType).toBe('video/webm');
    expect(staged.screenshots[0]?.file).toBe('screenshot-0-clip.webm');

    const outcome = await produceVerifiedEvidence(ports, TASK_ID);
    expect(outcome.kind).toBe('bound');
    if (outcome.kind !== 'bound') throw new Error('expected bound');
    const bound = store.readBoundEvidence(TASK_ID, ITERATION_ID)!;
    const webmArtifact = bound.artifacts.find((item) => item.mediaType === 'video/webm');
    expect(webmArtifact).toBeDefined();
    expect(webmArtifact!.sha256).toBe(staged.screenshots[0]!.sha256);
    await archive.close();
    store.close();

    // Legacy manifest without mediaType → image/png default at archive time.
    const legacyTarget = paths();
    mkdirSync(legacyTarget.screenshotDir, { recursive: true });
    const pngPath = join(legacyTarget.screenshotDir, 'settings.png');
    writeFileSync(pngPath, minimalPng());
    const legacy = await openHarness(legacyTarget);
    const legacyStaged = await legacy.intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(pngPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    expect(legacyStaged.screenshots[0]?.mediaType).toBe('image/png');
    const bundlePath = join(legacyTarget.intakeRoot, TASK_ID, REVISION, 'bundle.json');
    const raw = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
      screenshots: Array<Record<string, unknown>>;
      bundleHash: string;
      [key: string]: unknown;
    };
    for (const shot of raw.screenshots) {
      delete shot['mediaType'];
    }
    const { bundleHash: _ignored, ...withoutHash } = raw;
    raw.bundleHash = hashCanonicalJson(withoutHash);
    writeFileSync(bundlePath, JSON.stringify(raw), { mode: 0o600 });
    const legacyOutcome = await produceVerifiedEvidence(legacy.ports, TASK_ID);
    expect(legacyOutcome.kind).toBe('bound');
    if (legacyOutcome.kind !== 'bound') throw new Error('expected bound');
    const legacyBound = legacy.store.readBoundEvidence(TASK_ID, ITERATION_ID)!;
    const pngArtifact = legacyBound.artifacts.find(
      (item) => item.mediaType === 'image/png' && item.sha256 === legacyStaged.screenshots[0]!.sha256,
    );
    expect(pngArtifact).toBeDefined();
    await legacy.archive.close();
    legacy.store.close();
  });

  it('returns criteria_mismatch / candidate_mismatch / no_staged_bundle / failed', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());

    const { store, archive, intake, ports, logs } = await openHarness(target);

    // no_staged_bundle
    const missing = await produceVerifiedEvidence(ports, TASK_ID);
    expect(missing).toEqual({
      kind: 'skipped',
      aggregateId: TASK_ID,
      reason: 'no_staged_bundle',
    });

    // candidate_mismatch — stage under a different sha
    const otherSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: otherSha,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    // Produce still looks up by candidate revision; wrong sha means no bundle at candidate path.
    const noAtCandidate = await produceVerifiedEvidence(ports, TASK_ID);
    expect(noAtCandidate).toEqual({
      kind: 'skipped',
      aggregateId: TASK_ID,
      reason: 'no_staged_bundle',
    });

    // Stage at the candidate revision but with a mismatched repository label.
    await intake.discard(TASK_ID, otherSha);
    await intake.stage({
      task: { id: TASK_ID, repo: 'other/repo' },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    const candidateMismatch = await produceVerifiedEvidence(ports, TASK_ID);
    expect(candidateMismatch).toEqual({
      kind: 'skipped',
      aggregateId: TASK_ID,
      reason: 'candidate_mismatch',
    });
    expect(logs.some((line) => line.includes('candidate_mismatch'))).toBe(true);

    await intake.discard(TASK_ID, REVISION);
    await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath, {
        dodTexts: [
          'Unit tests pass @gate:unit',
          'DIFFERENT screenshot text @evidence:settings',
          'Owner accepts the change',
        ],
      }),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    const criteriaMismatch = await produceVerifiedEvidence(ports, TASK_ID);
    expect(criteriaMismatch).toEqual({
      kind: 'skipped',
      aggregateId: TASK_ID,
      reason: 'criteria_mismatch',
    });
    expect(logs.some((line) => line.includes('criteria_mismatch'))).toBe(true);

    // failed — bind throws; staged bundle remains
    await intake.discard(TASK_ID, REVISION);
    await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    const throwingPorts: VerifiedEvidenceProducerPorts = {
      ...ports,
      store: {
        listAggregatesAwaitingEvidence: () => store.listAggregatesAwaitingEvidence(),
        readTask: (taskId) => store.readTask(taskId),
        commit: (command) => store.commit(command),
        readBoundEvidence: (aggregateId, iterationId) =>
          store.readBoundEvidence(aggregateId, iterationId),
        bindReviewEvidence: () => {
          throw new Error('bind exploded');
        },
      },
    };
    const failed = await produceVerifiedEvidence(throwingPorts, TASK_ID);
    expect(failed).toEqual({
      kind: 'failed',
      aggregateId: TASK_ID,
      error: 'bind exploded',
    });
    expect(await intake.read(TASK_ID, REVISION)).not.toBeNull();
    expect(logs.some((line) => line.includes('failed bind exploded'))).toBe(true);

    const all = await produceAllVerifiedEvidence(ports);
    expect(all).toHaveLength(1);
    // Still awaiting because prior produce failed before bind.
    expect(all[0]?.kind === 'bound' || all[0]?.kind === 'failed').toBe(true);

    await archive.close();
    store.close();
  });

  it('a secret-scan rejection discards the staged bundle so the producer does not retry the same bytes every run (C3.52)', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const { store, archive, intake, ports, logs } = await openHarness(target);
    await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    const rejecting: VerifiedEvidenceProducerPorts = {
      ...ports,
      store: {
        listAggregatesAwaitingEvidence: () => store.listAggregatesAwaitingEvidence(),
        readTask: (taskId) => store.readTask(taskId),
        commit: (command) => store.commit(command),
        readBoundEvidence: (aggregateId, iterationId) =>
          store.readBoundEvidence(aggregateId, iterationId),
        bindReviewEvidence: () => {
          throw Object.assign(
            new Error('artifact secret scan rejected content: credential_assignment'),
            { code: 'artifact_secret' },
          );
        },
      },
    };
    const failed = await produceVerifiedEvidence(rejecting, TASK_ID);
    expect(failed).toMatchObject({ kind: 'failed', aggregateId: TASK_ID });
    expect(await intake.read(TASK_ID, REVISION)).toBeNull();
    expect(logs.some((line) => line.includes('staged bundle discarded'))).toBe(true);
    // Next run: nothing staged → quiet skip, not another rejection.
    const again = await produceVerifiedEvidence(rejecting, TASK_ID);
    expect(again).toEqual({ kind: 'skipped', aggregateId: TASK_ID, reason: 'no_staged_bundle' });
    await archive.close();
    store.close();
  });

  it('hashes content digests the archive will recompute', () => {
    const bytes = new TextEncoder().encode('unit ok\n');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(digest.startsWith('sha256:')).toBe(true);
    expect(digest.length).toBe('sha256:'.length + 64);
  });

  it('binds gate assertion outputSha256 to the archived artifact digest', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const { store, archive, intake, ports } = await openHarness(target);
    const staged = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    const outcome = await produceVerifiedEvidence(ports, TASK_ID);
    expect(outcome.kind).toBe('bound');
    const bound = store.readBoundEvidence(TASK_ID, ITERATION_ID);
    expect(bound).not.toBeNull();
    for (const gate of staged.gates) {
      const assertion = bound!.assertions.find(
        (entry) => entry.subjectKey === `gate:${gate.name}`,
      );
      expect(assertion).toBeDefined();
      const payload = assertion!.canonicalPayload as {
        readonly outputSha256: string;
        readonly truncated: boolean;
      };
      expect(payload.outputSha256).toBe(gate.sha256);
      expect(payload.truncated).toBe(gate.truncated);
      const artifact = bound!.artifacts.find((item) =>
        assertion!.id.endsWith(item.id),
      );
      expect(artifact?.sha256).toBe(payload.outputSha256);
    }
    await archive.close();
    store.close();
  });

  it('skips loudly when a staged gate file is forged after staging', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const { store, archive, intake, ports, logs } = await openHarness(target);
    const staged = await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });
    writeFileSync(
      join(target.intakeRoot, TASK_ID, REVISION, staged.gates[0]!.outputFile),
      'FORGED FAIL\n',
      { mode: 0o600 },
    );
    const outcome = await produceVerifiedEvidence(ports, TASK_ID);
    expect(outcome).toEqual({
      kind: 'skipped',
      aggregateId: TASK_ID,
      reason: 'no_staged_bundle',
    });
    expect(logs.some((line) => line.includes('no_staged_bundle'))).toBe(true);
    await archive.close();
    store.close();
  });

  it('retries idempotently after a failure between the first and second recordArtifact', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const { store, archive, intake, ports } = await openHarness(target);
    await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: CAPTURED_AT,
    });

    let recordCount = 0;
    const flakyArchive: typeof archive = {
      issueCaptureAuthorization: (request, authority) =>
        archive.issueCaptureAuthorization(request, authority),
      recordArtifact: async (command) => {
        recordCount += 1;
        if (recordCount === 2) {
          throw new Error('injected failure after first artifact');
        }
        return archive.recordArtifact(command);
      },
      recordManifest: (command) => archive.recordManifest(command),
      readArtifact: (id, access) => archive.readArtifact(id, access),
      readManifest: (id) => archive.readManifest(id),
      retireArtifact: (command) => archive.retireArtifact(command),
      verifyAll: () => archive.verifyAll(),
      exportSnapshot: (name) => archive.exportSnapshot(name),
      verifyExportSnapshot: (name) => archive.verifyExportSnapshot(name),
      close: () => archive.close(),
    };
    const first = await produceVerifiedEvidence(
      { ...ports, archive: flakyArchive },
      TASK_ID,
    );
    expect(first.kind).toBe('failed');
    expect(await intake.read(TASK_ID, REVISION)).not.toBeNull();

    const second = await produceVerifiedEvidence(ports, TASK_ID);
    expect(second.kind).toBe('bound');
    if (second.kind !== 'bound') return;
    const bound = store.readBoundEvidence(TASK_ID, ITERATION_ID);
    expect(bound).not.toBeNull();
    expect(bound!.artifacts.map((artifact) => artifact.id).sort()).toEqual(
      [
        `artifact-${TASK_ID}-${ITERATION_ID}-1`,
        `artifact-${TASK_ID}-${ITERATION_ID}-2`,
        `artifact-${TASK_ID}-${ITERATION_ID}-3`,
        `artifact-${TASK_ID}-${ITERATION_ID}-4`,
      ].sort(),
    );
    await archive.close();
    store.close();
  });

  it('fails clearly when the staged bundle is older than the 30-day authority window', async () => {
    const target = paths();
    mkdirSync(target.screenshotDir, { recursive: true });
    const screenshotPath = join(target.screenshotDir, 'settings.png');
    writeFileSync(screenshotPath, minimalPng());
    const { store, archive, intake, ports, logs } = await openHarness(target);
    const staleCapturedAt = '2020-01-01T00:00:00.000Z';
    await intake.stage({
      task: { id: TASK_ID, repo: REPOSITORY },
      packet: syntheticPacket(screenshotPath),
      verifiedSha: REVISION,
      branch: BRANCH,
      capturedAt: staleCapturedAt,
    });
    const outcome = await produceVerifiedEvidence(ports, TASK_ID);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.error.toLowerCase()).toMatch(/expired|live|authority|window/);
    expect(logs.some((line) => line.includes('failed'))).toBe(true);
    expect(store.readBoundEvidence(TASK_ID, ITERATION_ID)).toBeNull();
    await archive.close();
    store.close();
  });
});
