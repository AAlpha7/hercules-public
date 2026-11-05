import { describe, expect, it } from 'vitest';
import {
  assertArtifactRef,
  assertCandidateRef,
  assertEvidenceManifest,
  assertEvidenceManifestArtifacts,
  candidateRefsEqual,
  type ArtifactRef,
  type CandidateRef,
  type EvidenceManifest,
} from '../../src/domain/artifact.js';
import { V2InvariantError } from '../../src/domain/v2Invariant.js';

const candidate: CandidateRef = {
  kind: 'git',
  repository: 'example-org/acme',
  revision: 'abc123',
};

const artifact: ArtifactRef = {
  id: 'artifact-1',
  sha256: 'artifact-hash',
  mediaType: 'application/json',
  byteLength: 42,
  storageKey: 'artifacts/artifact-1',
  producerStageRunId: 'stage-1',
  createdAt: '2026-08-28T00:00:00Z',
  trustClass: 'primary',
  redactionState: 'none',
};

function manifest(overrides: Partial<EvidenceManifest> = {}): EvidenceManifest {
  return {
    id: 'manifest-1',
    taskId: 'task-1',
    contractVersion: 1,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    entries: [
      {
        artifactRefId: 'artifact-1',
        criterionIds: ['criterion-1'],
        candidateRef: candidate,
        observedAt: '2026-08-28T00:00:00Z',
        environmentRef: 'test',
        surface: 'mechanical_gate',
        trustClass: 'primary',
      },
    ],
    manifestHash: 'manifest-hash',
    createdAt: '2026-08-28T00:00:01Z',
    ...overrides,
  };
}

describe('V2 artifact and evidence identity', () => {
  it('compares every candidate identity field for all candidate kinds', () => {
    expect(candidateRefsEqual(candidate, { ...candidate })).toBe(true);
    expect(candidateRefsEqual(candidate, { ...candidate, revision: 'changed' })).toBe(false);
    expect(
      candidateRefsEqual(
        { kind: 'artifact', artifactId: 'a', sha256: 'hash' },
        { kind: 'artifact', artifactId: 'a', sha256: 'hash' },
      ),
    ).toBe(true);
    expect(
      candidateRefsEqual(
        { kind: 'external', system: 'mail', version: '1', digest: 'x' },
        { kind: 'external', system: 'mail', version: '2', digest: 'x' },
      ),
    ).toBe(false);
  });

  it('accepts criterion-bound primary evidence for the exact candidate', () => {
    expect(() => assertEvidenceManifest(manifest())).not.toThrow();
    expect(() => assertEvidenceManifestArtifacts(manifest(), [artifact])).not.toThrow();
  });

  it('validates trusted artifact metadata and cross-checks manifest trust', () => {
    expect(() => assertArtifactRef({ ...artifact, byteLength: -1 })).toThrow(
      V2InvariantError,
    );
    expect(() =>
      assertArtifactRef({
        ...artifact,
        trustClass: 'bogus' as ArtifactRef['trustClass'],
      }),
    ).toThrow(V2InvariantError);
    expect(() => assertEvidenceManifestArtifacts(manifest(), [])).toThrow(
      'match trusted artifact identity and trust',
    );
    expect(() =>
      assertEvidenceManifestArtifacts(manifest(), [
        { ...artifact, trustClass: 'derived' },
      ]),
    ).toThrow('match trusted artifact identity and trust');
    expect(() => assertEvidenceManifestArtifacts(manifest(), [artifact, artifact])).toThrow(
      'trusted artifact ids must be unique',
    );
    expect(() =>
      assertEvidenceManifestArtifacts(
        manifest(),
        null as unknown as readonly ArtifactRef[],
      ),
    ).toThrow(V2InvariantError);
  });

  it('rejects evidence that is rebound to a different candidate', () => {
    const changed: CandidateRef = { ...candidate, revision: 'changed' };
    expect(() =>
      assertEvidenceManifest(
        manifest({
          entries: [{ ...manifest().entries[0]!, candidateRef: changed }],
        }),
      ),
    ).toThrow(V2InvariantError);
  });

  it('rejects duplicate artifacts and entries without criterion bindings', () => {
    const entry = manifest().entries[0]!;
    expect(() => assertEvidenceManifest(manifest({ entries: [entry, entry] }))).toThrow(
      'unique',
    );
    expect(() =>
      assertEvidenceManifest(manifest({ entries: [{ ...entry, criterionIds: [] }] })),
    ).toThrow('at least one criterion');
  });

  it('rejects empty candidate identity fields even when manifest and evidence match', () => {
    const emptyCandidate: CandidateRef = { kind: 'git', repository: '', revision: '' };
    expect(() => assertCandidateRef(emptyCandidate)).toThrow('must be non-empty');
    expect(candidateRefsEqual(emptyCandidate, { ...emptyCandidate })).toBe(false);
    expect(() =>
      assertEvidenceManifest(
        manifest({
          candidateRef: emptyCandidate,
          entries: [{ ...manifest().entries[0]!, candidateRef: emptyCandidate }],
        }),
      ),
    ).toThrow(V2InvariantError);
  });

  it('rejects decoded evidence with an unknown trust class', () => {
    const entry = manifest().entries[0]!;
    expect(() =>
      assertEvidenceManifest(
        manifest({
          entries: [
            {
              ...entry,
              trustClass: 'bogus' as typeof entry.trustClass,
            },
          ],
        }),
      ),
    ).toThrow(V2InvariantError);
  });

  it('rejects sparse criterion bindings instead of treating array holes as strings', () => {
    const entry = manifest().entries[0]!;
    expect(() =>
      assertEvidenceManifest(
        manifest({ entries: [{ ...entry, criterionIds: Array<string>(1) }] }),
      ),
    ).toThrow('at least one criterion');
  });

  it('rejects duplicate criterion identities in one evidence entry', () => {
    const entry = manifest().entries[0]!;
    expect(() =>
      assertEvidenceManifest(
        manifest({
          entries: [
            { ...entry, criterionIds: ['criterion-1', 'criterion-1'] },
          ],
        }),
      ),
    ).toThrow('at least one criterion');
  });

  it('rejects a decoded null manifest and compares malformed candidates safely', () => {
    expect(() => assertCandidateRef(null as unknown as CandidateRef)).toThrow(
      V2InvariantError,
    );
    expect(() =>
      assertEvidenceManifest(null as unknown as EvidenceManifest),
    ).toThrow(V2InvariantError);
    expect(candidateRefsEqual(null as unknown as CandidateRef, candidate)).toBe(false);
  });
});
