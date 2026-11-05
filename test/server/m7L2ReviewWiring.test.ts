import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openIsolatedM7ReviewApiDeps } from '../../src/server/api.js';
import { buildM7ReviewFixtureEnvelope } from '../../scripts/l2-review-fixture-data.mjs';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seededScratch() {
  const root = await mkdtemp(join(tmpdir(), 'hercules-m7-wiring-'));
  roots.push(root);
  const workRoot = join(root, 'work');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workRoot);
  const fixturePath = join(workRoot, 'm7-review-fixture.json');
  await writeFile(
    fixturePath,
    JSON.stringify(buildM7ReviewFixtureEnvelope()),
    { encoding: 'utf8', mode: 0o600 },
  );
  return { workRoot, fixturePath };
}

describe('M7 isolated review composition seam', () => {
  it('binds every primary artifact byte-for-byte to its asserted payload', () => {
    const fixture = buildM7ReviewFixtureEnvelope();
    for (const task of fixture.payload.tasks) {
      const artifact = task.source.artifacts[0]!;
      const assertion = task.source.assertions[0]!;
      const evidence = task.evidence[0]!;
      const bytes = Buffer.from(evidence.contentBase64, 'base64');
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      expect(JSON.parse(bytes.toString('utf8'))).toEqual(assertion.canonicalPayload);
      expect(digest).toBe(assertion.payloadHash);
      expect(digest).toBe(artifact.sha256);
      expect(digest).toBe(evidence.sha256);
    }
    const failed = fixture.payload.tasks.find(
      (task) => task.source.task.id === 'l2-m7-fail',
    )!;
    expect(
      JSON.parse(Buffer.from(failed.evidence[0]!.contentBase64, 'base64').toString('utf8')),
    ).toEqual({ passed: false });
  });

  it('performs no provider IO unless an explicit fixture path is present', async () => {
    await expect(openIsolatedM7ReviewApiDeps({
      env: { HERCULES_ADAPTER: 'grok', HERCULES_FAKE_FAULT_INJECTION: '1' },
      workRoot: '/path/that/does/not/exist',
    })).resolves.toEqual({});
  });

  it('keeps every V2 port disabled when the isolated boot guard is absent', async () => {
    const input = await seededScratch();
    await expect(openIsolatedM7ReviewApiDeps({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_M7_L2_FIXTURE_PATH: input.fixturePath,
      },
      workRoot: input.workRoot,
    })).resolves.toEqual({});
  });

  it('returns one shared source and decision authority only for a valid fake fixture', async () => {
    const input = await seededScratch();
    const deps = await openIsolatedM7ReviewApiDeps({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_L2_ISOLATED: '1',
        HERCULES_M7_L2_FIXTURE_PATH: input.fixturePath,
      },
      workRoot: input.workRoot,
    });
    expect(deps.reviewPackageV2).toBe(deps.reviewDecisions);
    expect(deps.reviewDecisions?.isReady()).toBe(true);
    expect(deps.reviewEvidence?.isReady()).toBe(true);
    expect(deps.learningProposals?.isReady()).toBe(true);
    expect(deps.reviewDecisionActor?.isReady()).toBe(true);
    expect(await deps.reviewPackageV2?.read('l2-m7-pass'))
      .toMatchObject({ status: 'available' });
  });

  it('keeps normal startup available while malformed scratch input disables every V2 port', async () => {
    const input = await seededScratch();
    await writeFile(input.fixturePath, '{}', 'utf8');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(openIsolatedM7ReviewApiDeps({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_L2_ISOLATED: '1',
        HERCULES_M7_L2_FIXTURE_PATH: input.fixturePath,
      },
      workRoot: input.workRoot,
    })).resolves.toEqual({});
    expect(log).toHaveBeenCalledWith(
      '[hercules] isolated M7 review fixture rejected; V2 capabilities disabled',
    );
  });
});
