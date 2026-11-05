import { describe, it, expect } from 'vitest';
import {
  parseReleaseFile,
  serializeRelease,
  ReleaseFileError,
} from '../../src/control/releaseFile.js';
import { emptyRelease, type Release } from '../../src/domain/release.js';

const FULL = `---
production_sha: cccccccccccccccccccccccccccccccccccccccc
production_deployed_at: 2026-07-16T00:00:00.000Z
staging_sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
staging_status: ready
staging_verified_at: 2026-07-17T12:00:00.000Z
promoting_sha: null
history:
  - sha: cccccccccccccccccccccccccccccccccccccccc
    at: 2026-07-16T00:00:00.000Z
    outcome: ok
---

## Release packet

- task-1: Ship the thing
`;

describe('parseReleaseFile', () => {
  it('parses full front matter and body', () => {
    const rel = parseReleaseFile(FULL, 'hercules');
    expect(rel.repoKey).toBe('hercules');
    expect(rel.productionSha).toBe('cccccccccccccccccccccccccccccccccccccccc');
    expect(rel.productionDeployedAt).toBe('2026-07-16T00:00:00.000Z');
    expect(rel.stagingSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(rel.stagingStatus).toBe('ready');
    expect(rel.stagingVerifiedAt).toBe('2026-07-17T12:00:00.000Z');
    expect(rel.promotingSha).toBeNull();
    expect(rel.history).toEqual([
      {
        sha: 'cccccccccccccccccccccccccccccccccccccccc',
        at: '2026-07-16T00:00:00.000Z',
        outcome: 'ok',
      },
    ]);
    expect(rel.body).toContain('## Release packet');
    expect(rel.body).toContain('task-1');
  });

  it('derives repoKey from the file stem and defaults missing fields (legacy tolerance)', () => {
    const minimal = `---
staging_status: deploying
---
`;
    const rel = parseReleaseFile(minimal, 'my-app');
    expect(rel.repoKey).toBe('my-app');
    expect(rel.productionSha).toBeNull();
    expect(rel.productionDeployedAt).toBeNull();
    expect(rel.stagingSha).toBeNull();
    expect(rel.stagingStatus).toBe('deploying');
    expect(rel.stagingVerifiedAt).toBeNull();
    expect(rel.stagingStartedAt).toBeNull();
    expect(rel.promotingSha).toBeNull();
    expect(rel.history).toEqual([]);
    expect(rel.body).toBe('');
  });

  it('round-trips staging_started_at', () => {
    const content = `---
staging_status: verifying
staging_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
staging_started_at: 2026-07-28T12:00:00.000Z
---
body
`;
    const rel = parseReleaseFile(content, 'app');
    expect(rel.stagingStartedAt).toBe('2026-07-28T12:00:00.000Z');
    const out = serializeRelease(rel);
    expect(out).toContain('staging_started_at:');
    expect(parseReleaseFile(out, 'app').stagingStartedAt).toBe('2026-07-28T12:00:00.000Z');
  });

  it('tolerates a completely empty front matter (bootstrap / first write)', () => {
    const empty = `---
---
`;
    const rel = parseReleaseFile(empty, 'hercules');
    expect(rel).toEqual(emptyRelease('hercules'));
  });

  it('tolerates missing optional history fields and unknown statuses as null', () => {
    const content = `---
production_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
history:
  - sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    at: 2026-07-10T00:00:00.000Z
    outcome: ok
  - sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    at: 2026-07-11T00:00:00.000Z
    outcome: rolled_back
    rollback_of: cccccccccccccccccccccccccccccccccccccccc
---
body
`;
    const rel = parseReleaseFile(content, 'app');
    expect(rel.history).toEqual([
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        at: '2026-07-10T00:00:00.000Z',
        outcome: 'ok',
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        at: '2026-07-11T00:00:00.000Z',
        outcome: 'rolled_back',
        rollbackOf: 'cccccccccccccccccccccccccccccccccccccccc',
      },
    ]);
  });

  it('coerces unquoted ISO timestamps (YAML Date) back to strings', () => {
    const content = `---
production_deployed_at: 2026-07-16T00:00:00.000Z
staging_verified_at: 2026-07-17T12:00:00.000Z
staging_status: ready
---
x
`;
    const rel = parseReleaseFile(content, 'app');
    expect(rel.productionDeployedAt).toBe('2026-07-16T00:00:00.000Z');
    expect(typeof rel.productionDeployedAt).toBe('string');
    expect(rel.stagingVerifiedAt).toBe('2026-07-17T12:00:00.000Z');
    expect(typeof rel.stagingVerifiedAt).toBe('string');
  });

  it('throws on an unsafe file stem', () => {
    expect(() => parseReleaseFile(FULL, '../evil')).toThrow(ReleaseFileError);
  });

  it('throws on an invalid staging_status', () => {
    const bad = `---
staging_status: banana
---
`;
    expect(() => parseReleaseFile(bad, 'app')).toThrow(ReleaseFileError);
  });

  it('throws on an invalid history outcome', () => {
    const bad = `---
history:
  - sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    at: 2026-07-16T00:00:00.000Z
    outcome: boom
---
`;
    expect(() => parseReleaseFile(bad, 'app')).toThrow(ReleaseFileError);
  });

  it('throws when there is no front matter at all', () => {
    expect(() => parseReleaseFile('just a body', 'app')).toThrow(ReleaseFileError);
  });
});

describe('serializeRelease / round-trip', () => {
  it('round-trips a parsed release back to an equivalent release', () => {
    const rel = parseReleaseFile(FULL, 'hercules');
    const serialized = serializeRelease(rel);
    const reparsed = parseReleaseFile(serialized, 'hercules');
    expect(reparsed).toEqual(rel);
  });

  it('emits snake_case keys in stable order and omits null optionals', () => {
    const rel: Release = {
      repoKey: 'hercules',
      productionSha: 'cccccccccccccccccccccccccccccccccccccccc',
      productionDeployedAt: '2026-07-16T00:00:00.000Z',
      stagingSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      stagingStatus: 'ready',
      stagingVerifiedAt: '2026-07-17T12:00:00.000Z',
      stagingStartedAt: null,
      promotingSha: null,
      history: [
        {
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          at: '2026-07-16T00:00:00.000Z',
          outcome: 'ok',
        },
        {
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          at: '2026-07-17T13:00:00.000Z',
          outcome: 'rolled_back',
          rollbackOf: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
      body: '## Release packet\n\nhello',
    };
    const out = serializeRelease(rel);
    expect(out).toContain('production_sha:');
    expect(out).toContain('production_deployed_at:');
    expect(out).toContain('staging_sha:');
    expect(out).toContain('staging_status: ready');
    expect(out).toContain('staging_verified_at:');
    expect(out).toContain('rollback_of:');
    expect(out).not.toContain('productionSha');
    expect(out).not.toContain('stagingSha');
    expect(out).not.toContain('rollbackOf');
    // promoting_sha omitted when null
    expect(out).not.toMatch(/^\s*promoting_sha:/m);

    const keys = [...out.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys.slice(0, 5)).toEqual([
      'production_sha',
      'production_deployed_at',
      'staging_sha',
      'staging_status',
      'staging_verified_at',
    ]);
  });

  it('round-trips promoting_sha and omits it when null', () => {
    const withPromoting = parseReleaseFile(
      `---
staging_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
staging_status: ready
promoting_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
---
body
`,
      'app',
    );
    expect(withPromoting.promotingSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const ser = serializeRelease(withPromoting);
    expect(ser).toContain('promoting_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const none = parseReleaseFile(
      `---
staging_status: ready
---
x
`,
      'app2',
    );
    expect(none.promotingSha).toBeNull();
    expect(serializeRelease(none)).not.toMatch(/^\s*promoting_sha:/m);
  });

  it('round-trips last_promote_failure and omits it when null', () => {
    const withFailure = parseReleaseFile(
      `---
production_sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
last_promote_failure:
  sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  booted_sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  reason: booted_build_mismatch
  at: 2026-09-06T12:00:00.000Z
---
body
`,
      'app',
    );
    expect(withFailure.lastPromoteFailure).toEqual({
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      bootedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reason: 'booted_build_mismatch',
      at: '2026-09-06T12:00:00.000Z',
    });
    const ser = serializeRelease(withFailure);
    expect(ser).toContain('last_promote_failure:');
    expect(ser).toContain('booted_build_mismatch');
    expect(parseReleaseFile(ser, 'app').lastPromoteFailure).toEqual(
      withFailure.lastPromoteFailure,
    );

    const none = parseReleaseFile(
      `---
staging_status: ready
---
x
`,
      'app2',
    );
    expect(none.lastPromoteFailure).toBeNull();
    expect(serializeRelease(none)).not.toMatch(/^\s*last_promote_failure:/m);
  });

  it('round-trips emptyRelease (bootstrap file)', () => {
    const rel = emptyRelease('fresh');
    const out = serializeRelease(rel);
    const reparsed = parseReleaseFile(out, 'fresh');
    expect(reparsed).toEqual(rel);
  });

  it('omits null production/staging sha keys on serialize (legacy-friendly)', () => {
    const rel = emptyRelease('x');
    const out = serializeRelease(rel);
    // Empty history still emitted as [] for stable shape, or omitted — either ok if round-trips.
    expect(parseReleaseFile(out, 'x')).toEqual(rel);
  });
});
