import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ArchiveTypeError,
  assertArtifactArchiveAdmissionGate,
  createArtifactArchiveAdmissionGate,
  deriveArtifactCaptureAuthorization,
  MAX_ARTIFACT_BYTES,
  snapshotArchiveAuthorityContext,
  snapshotArtifactAccessContext,
  snapshotArtifactEvidenceArchiveOptions,
  snapshotCandidateRef,
  snapshotIssueArtifactCaptureAuthorizationRequest,
  snapshotRecordArtifactCommand,
  snapshotRecordEvidenceManifestCommand,
  snapshotRetireArtifactCommand,
  TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER,
  type ArchiveAuthorityContext,
  type ArtifactAccessContext,
  type ArtifactCaptureObservation,
  type ArtifactCapabilityIssuer,
} from '../../../src/control/artifacts/archiveTypes.js';

const now = '2026-08-28T12:00:00.000Z';
const sha = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = `sha256:${'a'.repeat(64)}` as const;
const gitCandidate = {
  kind: 'git',
  repository: 'example-org/acme',
  revision: 'b'.repeat(40),
} as const;

function issuer(): Readonly<ArtifactCapabilityIssuer> {
  return TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER;
}

function TypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...TypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function authorityInput() {
  return {
    issuer: 'trusted-verifier',
    taskId: 'task-1',
    contractVersion: 1,
    iterationId: 'iteration-1',
    producerStageRunId: 'stage-1',
    stageType: 'verify',
    stageStartedAt: '2026-08-28T11:55:00.000Z',
    candidateRef: {
      kind: 'git' as const,
      repository: String(gitCandidate.repository),
      revision: String(gitCandidate.revision),
    },
    environmentRef: 'offline-test',
    surface: 'mechanical-gate',
    maximumTrustClass: 'primary',
    maximumAccessClass: 'operator',
    maximumByteLength: 1024,
    allowedMediaTypes: ['application/json'],
    issuedAt: '2026-08-28T11:59:00.000Z',
    expiresAt: '2026-08-28T12:01:00.000Z',
  };
}

function observationFor(bytes: Uint8Array): ArtifactCaptureObservation {
  return issuer().issueCaptureObservation({
    authorizationId: 'authorization-1',
    sha256: sha(bytes),
    byteLength: bytes.byteLength,
    redactionState: 'none',
    accessClass: 'operator',
    observedAt: now,
  });
}

describe('M5 archive strict values', () => {
  it('accepts only exact canonical candidate schemas and returns owned frozen copies', () => {
    const input = {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: 'b'.repeat(40),
    };
    const copy = snapshotCandidateRef(input);
    input.repository = 'changed';

    expect(copy).toEqual(gitCandidate);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(() => snapshotCandidateRef({ ...gitCandidate, extra: true })).toThrow(
      'exact schema',
    );
    expect(() => snapshotCandidateRef({ ...gitCandidate, revision: 'ABC123' })).toThrow(
      'exact lowercase Git commit hash',
    );
    expect(() =>
      snapshotCandidateRef({ kind: 'artifact', artifactId: 'a', sha256: 'plain-hash' }),
    ).toThrow('exact lowercase SHA-256');
    expect(() =>
      snapshotCandidateRef({
        kind: 'external',
        system: 'ci',
        version: '1',
        digest: `sha256:${'A'.repeat(64)}`,
      }),
    ).toThrow('exact lowercase SHA-256');
    const accessor = { repository: 'example-org/acme', revision: 'b'.repeat(40) };
    Object.defineProperty(accessor, 'kind', { enumerable: true, get: () => 'git' });
    expect(() => snapshotCandidateRef(accessor)).toThrow('own data property');
  });

  it('rejects non-canonical timestamps, unsafe media types, control text, and excess bounds', () => {
    expect(() =>
      snapshotRetireArtifactCommand({
        id: 'retire-1',
        idempotencyKey: 'idem-1',
        artifactRefId: 'artifact-1',
        reason: 'expired',
        policyCutoff: '2026-08-28T12:00:00Z',
      }),
    ).toThrow('canonical UTC');
    expect(() =>
      snapshotIssueArtifactCaptureAuthorizationRequest({
        id: 'authorization-1',
        artifactRefId: 'artifact-1',
        idempotencyKey: 'idem-1',
        mediaType: 'Application/JSON',
        maximumByteLength: 1,
        accessClass: 'operator',
      }),
    ).toThrow('lower-case type/subtype');
    expect(() =>
      snapshotIssueArtifactCaptureAuthorizationRequest({
        id: 'authorization-1\nforged',
        artifactRefId: 'artifact-1',
        idempotencyKey: 'idem-1',
        mediaType: 'application/json',
        maximumByteLength: MAX_ARTIFACT_BYTES + 1,
        accessClass: 'operator',
      }),
    ).toThrow(ArchiveTypeError);
  });
});

describe('M5 opaque archive capabilities', () => {
  it('keeps capability issuance behind one explicit test-only facade', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const forbidden = /\b(?:TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER|createArtifactArchiveAdmissionGate|mintArchiveAuthorityContext|mintArtifactCaptureObservation|mintArtifactAccessContext)\b/;
    const violations = TypeScriptFiles(sourceRoot)
      .filter((path) => !path.endsWith('/control/artifacts/archiveTypes.ts'))
      .filter((path) => !path.endsWith('/control/artifacts/evidenceArchive.ts'))
      .filter((path) => forbidden.test(readFileSync(path, 'utf8')));
    expect(violations).toEqual([]);
  });

  it('pins openArchiveCapabilityIssuerForComposition to main.ts and archiveTypes.ts only', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const needle = /\bopenArchiveCapabilityIssuerForComposition\b/;
    const violations = TypeScriptFiles(sourceRoot)
      .filter((path) => !path.endsWith('/control/artifacts/archiveTypes.ts'))
      .filter((path) => !path.endsWith('/main.ts'))
      .filter((path) => needle.test(readFileSync(path, 'utf8')));
    expect(violations).toEqual([]);
  });

  it('rejects forged, foreign, inactive, and re-entrant admission capabilities', () => {
    const gate = createArtifactArchiveAdmissionGate();
    const foreign = createArtifactArchiveAdmissionGate();
    assertArtifactArchiveAdmissionGate(gate);
    expect(() => assertArtifactArchiveAdmissionGate({
      enter: () => ({}),
      assertOwns: () => undefined,
      leave: () => undefined,
    })).toThrow('forged');

    const token = gate.enter();
    expect(() => gate.enter()).toThrow('busy');
    expect(() => gate.assertOwns({})).toThrow('forged or inactive');
    expect(() => foreign.assertOwns(token)).toThrow('forged or inactive');
    gate.leave(token);
    expect(() => gate.assertOwns(token)).toThrow('forged or inactive');
  });

  it('rejects plain-object authority forgeries and snapshots minted authority facts', () => {
    const input = authorityInput();
    const authority = issuer().issueArchiveAuthority(input);
    const facts = snapshotArchiveAuthorityContext(authority, now);
    input.candidateRef.repository = 'mutated-after-mint';
    input.allowedMediaTypes[0] = 'text/plain';

    expect(facts.candidateRef).toEqual(gitCandidate);
    expect(facts.allowedMediaTypes).toEqual(['application/json']);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(() =>
      snapshotArchiveAuthorityContext(
        { ...facts } as unknown as ArchiveAuthorityContext,
        now,
      ),
    ).toThrow('forged');
    expect(() => JSON.stringify(authority)).toThrow('cannot be serialized');
  });

  it('enforces primary-stage and authority validity windows', () => {
    expect(() =>
      issuer().issueArchiveAuthority({ ...authorityInput(), stageType: 'implement' }),
    ).toThrow('only a verify stage');
    const authority = issuer().issueArchiveAuthority(authorityInput());
    expect(() =>
      snapshotArchiveAuthorityContext(authority, '2026-08-28T12:02:00.000Z'),
    ).toThrow('not live');
  });

  it('derives authorization provenance and rejects request widening', () => {
    const authorityInputValue = authorityInput();
    const authority = issuer().issueArchiveAuthority(authorityInputValue);
    const request = {
      id: 'authorization-1',
      artifactRefId: 'artifact-1',
      idempotencyKey: 'idem-1',
      mediaType: 'application/json',
      maximumByteLength: 512,
      accessClass: 'restricted',
    };
    const authorization = deriveArtifactCaptureAuthorization(request, authority, now);
    authorityInputValue.taskId = 'mutated';
    request.maximumByteLength = 1;

    expect(authorization).toMatchObject({
      id: 'authorization-1',
      taskId: 'task-1',
      producerStageRunId: 'stage-1',
      maximumTrustClass: 'primary',
      maximumByteLength: 512,
      accessClass: 'restricted',
    });
    expect(() =>
      deriveArtifactCaptureAuthorization(
        { ...request, maximumByteLength: 1025 },
        authority,
        now,
      ),
    ).toThrow('exceeds the authority grant');

    const restrictedAuthority = issuer().issueArchiveAuthority({
      ...authorityInput(),
      maximumAccessClass: 'restricted',
    });
    expect(() =>
      deriveArtifactCaptureAuthorization(
        { ...request, accessClass: 'operator' },
        restrictedAuthority,
        now,
      ),
    ).toThrow('weakens the authority restriction');
  });

  it('binds access capabilities to exact digest, class, purpose, issuer, and expiry', () => {
    const access = issuer().issueArtifactAccess({
      sha256: digest,
      purpose: 'read',
      authorizationClass: 'restricted',
      issuer: 'operator-session-1',
      issuedAt: '2026-08-28T11:59:00.000Z',
      expiresAt: '2026-08-28T12:01:00.000Z',
    });

    expect(snapshotArtifactAccessContext(access, digest, now)).toMatchObject({
      sha256: digest,
      purpose: 'read',
      authorizationClass: 'restricted',
      issuer: 'operator-session-1',
    });
    const reviewAccess = issuer().issueArtifactAccess({
      sha256: digest,
      purpose: 'operator_review',
      authorizationClass: 'restricted',
      issuer: 'operator-session-1',
      issuedAt: '2026-08-28T11:59:00.000Z',
      expiresAt: '2026-08-28T12:01:00.000Z',
    });
    expect(snapshotArtifactAccessContext(reviewAccess, digest, now).purpose)
      .toBe('operator_review');
    expect(() =>
      snapshotArtifactAccessContext(
        access,
        `sha256:${'c'.repeat(64)}`,
        now,
      ),
    ).toThrow('requested digest');
    expect(() =>
      snapshotArtifactAccessContext(
        { sha256: digest } as unknown as ArtifactAccessContext,
        digest,
        now,
      ),
    ).toThrow('forged');
    expect(() =>
      snapshotArtifactAccessContext(access, digest, '2026-08-28T12:01:00.001Z'),
    ).toThrow('not live');
  });

  it('rejects forged or mismatched observations and unsafe redaction/access pairs', () => {
    const bytes = new TextEncoder().encode('owned bytes');
    const observation = observationFor(bytes);
    const command = {
      authorizationId: 'authorization-1',
      observation,
      mediaType: 'text/plain; charset=utf-8',
      bytes,
    };
    expect(() =>
      snapshotRecordArtifactCommand(
        { ...command, observation: {} as ArtifactCaptureObservation },
        { maximumArtifactBytes: 1024, clockSkewMs: 0 },
        { stageStartedAt: '2026-08-28T11:59:00.000Z', capturedAt: now },
      ),
    ).toThrow('forged');
    expect(() =>
      issuer().issueCaptureObservation({
        authorizationId: 'authorization-1',
        sha256: sha(bytes),
        byteLength: bytes.byteLength,
        redactionState: 'restricted',
        accessClass: 'operator',
        observedAt: now,
      }),
    ).toThrow('restricted access');

    const futureObservation = issuer().issueCaptureObservation({
      authorizationId: 'authorization-1',
      sha256: sha(bytes),
      byteLength: bytes.byteLength,
      redactionState: 'none',
      accessClass: 'operator',
      observedAt: '2026-08-28T12:00:00.001Z',
    });
    expect(() =>
      snapshotRecordArtifactCommand(
        { ...command, observation: futureObservation },
        { maximumArtifactBytes: 1024, clockSkewMs: 50 },
        { stageStartedAt: '2026-08-28T11:59:00.000Z', capturedAt: now },
      ),
    ).toThrow('capture window');
  });
});

describe('M5 synchronous owned snapshots', () => {
  it('copies bytes and hashes only the owned copy before returning', () => {
    const bytes = new TextEncoder().encode('owned bytes');
    const expectedBytes = Uint8Array.from(bytes);
    const snapshot = snapshotRecordArtifactCommand(
      {
        authorizationId: 'authorization-1',
        observation: observationFor(bytes),
        mediaType: 'text/plain; charset=utf-8',
        bytes,
      },
      { maximumArtifactBytes: 1024, clockSkewMs: 0 },
      { stageStartedAt: '2026-08-28T11:59:00.000Z', capturedAt: now },
    );
    bytes.fill(0);

    expect(snapshot.bytes).toEqual(expectedBytes);
    expect(snapshot.bytes).not.toBe(bytes);
    expect(snapshot.sha256).toBe(sha(expectedBytes));
    expect(snapshot.byteLength).toBe(expectedBytes.byteLength);
  });

  it('copies typed-array bytes without consulting a hostile iterator', () => {
    const bytes = new Uint8Array([1]);
    Object.defineProperty(bytes, Symbol.iterator, {
      configurable: true,
      value: function* hostileIterator() {
        yield 9;
        yield 9;
        yield 9;
      },
    });
    const snapshot = snapshotRecordArtifactCommand(
      {
        authorizationId: 'authorization-1',
        observation: observationFor(bytes),
        mediaType: 'application/octet-stream',
        bytes,
      },
      { maximumArtifactBytes: 1, clockSkewMs: 0 },
      { stageStartedAt: '2026-08-28T11:59:00.000Z', capturedAt: now },
    );
    expect([...snapshot.bytes]).toEqual([1]);
  });

  it('rejects SharedArrayBuffer-backed views and over-limit bytes', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    expect(() =>
      snapshotRecordArtifactCommand(
        {
          authorizationId: 'authorization-1',
          observation: {} as ArtifactCaptureObservation,
          mediaType: 'application/octet-stream',
          bytes: shared,
        },
        { maximumArtifactBytes: 4, clockSkewMs: 0 },
        { stageStartedAt: now, capturedAt: now },
      ),
    ).toThrow('SharedArrayBuffer');

    const bytes = new Uint8Array(2);
    expect(() =>
      snapshotRecordArtifactCommand(
        {
          authorizationId: 'authorization-1',
          observation: observationFor(bytes),
          mediaType: 'application/octet-stream',
          bytes,
        },
        { maximumArtifactBytes: 1, clockSkewMs: 0 },
        { stageStartedAt: now, capturedAt: now },
      ),
    ).toThrow('exceed');
  });

  it('deep-copies, validates, and canonically orders manifest entry requests', () => {
    const input = {
      id: 'manifest-1',
      idempotencyKey: 'idem-1',
      taskId: 'task-1',
      contractVersion: 1,
      iterationId: 'iteration-1',
      entries: [
        { artifactRefId: 'artifact-b', criterionIds: ['criterion-2', 'criterion-1'] },
        { artifactRefId: 'artifact-a', criterionIds: ['criterion-3'] },
      ],
    };
    const snapshot = snapshotRecordEvidenceManifestCommand(input);
    input.entries[0]!.artifactRefId = 'changed';
    input.entries[0]!.criterionIds[0] = 'changed';

    expect(snapshot.entries).toEqual([
      { artifactRefId: 'artifact-a', criterionIds: ['criterion-3'] },
      { artifactRefId: 'artifact-b', criterionIds: ['criterion-1', 'criterion-2'] },
    ]);
    expect(Object.isFrozen(snapshot.entries[0]?.criterionIds)).toBe(true);
    expect(() =>
      snapshotRecordEvidenceManifestCommand({
        ...input,
        entries: [
          { artifactRefId: 'artifact-a', criterionIds: ['criterion-1'] },
          { artifactRefId: 'artifact-a', criterionIds: ['criterion-2'] },
        ],
      }),
    ).toThrow('must be unique');
    expect(() =>
      snapshotRecordEvidenceManifestCommand({ ...input, unexpected: true }),
    ).toThrow('exact schema');
    expect(() => snapshotRecordEvidenceManifestCommand(input, 2, 2)).toThrow(
      'total configured bound',
    );
  });

  it('captures the exact factory option graph and callback identity once', () => {
    const firstClock = () => now;
    const options = {
      artifactRoot: '/tmp/hercules-artifacts',
      databasePath: '/tmp/hercules-state/shadow.sqlite',
      databaseTrustedRoot: '/tmp/hercules-state',
      exportRoot: '/tmp/hercules-exports',
      controlRepositoryRoot: '/tmp/hercules-control',
      providerWorkRoots: ['/tmp/provider-b', '/tmp/provider-a'],
      policy: {
        maximumArtifactBytes: 1024,
        lockAcquireTimeoutMs: 100,
        clockSkewMs: 50,
        maximumCommandEntries: 20,
        maximumManifestCriteria: 40,
        inventoryPageSize: 10,
        retentionDays: null,
        orphanGraceDays: 7,
      },
      clock: firstClock,
    };
    const snapshot = snapshotArtifactEvidenceArchiveOptions(options);
    options.artifactRoot = '/tmp/changed';
    options.policy.maximumArtifactBytes = 1;
    options.clock = () => 'changed';

    expect(snapshot.artifactRoot).toBe('/tmp/hercules-artifacts');
    expect(snapshot.policy.maximumArtifactBytes).toBe(1024);
    expect(snapshot.providerWorkRoots).toEqual(['/tmp/provider-a', '/tmp/provider-b']);
    expect(snapshot.clock).toBe(firstClock);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
    expect(() =>
      snapshotArtifactEvidenceArchiveOptions({ ...options, unknown: true }),
    ).toThrow('exact schema');
    expect(() => snapshotArtifactEvidenceArchiveOptions({
      ...options,
      databaseTrustedRoot: '/tmp',
    })).toThrow('immediate child');
  });
});
