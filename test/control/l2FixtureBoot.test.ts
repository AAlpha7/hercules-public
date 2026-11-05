/**
 * Empty-plane L2 auto-seed (main WORKFLOW still uses repos:{} + no tasks).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoSeedL2FixtureIfNeeded,
  shouldAutoSeedL2Fixture,
} from '../../src/control/l2FixtureBoot.js';

describe('l2FixtureBoot', () => {
  let ctrlDir: string;
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'hercules-l2-boot-'));
    ctrlDir = join(scratchDir, 'ctrl');
    await mkdir(ctrlDir);
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('shouldAutoSeed only for fake + empty tasks', async () => {
    await mkdir(join(ctrlDir, 'tasks'), { recursive: true });
    expect(
      shouldAutoSeedL2Fixture({ adapter: 'fake', controlDir: ctrlDir }),
    ).toBe(true);
    expect(
      shouldAutoSeedL2Fixture({ adapter: 'grok', controlDir: ctrlDir }),
    ).toBe(false);

    await writeFile(join(ctrlDir, 'tasks', 'some.md'), '---\nid: some\n---\n', 'utf8');
    expect(
      shouldAutoSeedL2Fixture({ adapter: 'fake', controlDir: ctrlDir }),
    ).toBe(false);
  });

  it('autoSeed fills empty fake plane with fixture review task', async () => {
    await mkdir(join(ctrlDir, 'tasks'), { recursive: true });
    await writeFile(join(ctrlDir, 'repos.yaml'), 'repos: {}\n', 'utf8');
    const ran = autoSeedL2FixtureIfNeeded(ctrlDir, {
      ...process.env,
      HERCULES_ADAPTER: 'fake',
    });
    expect(ran).toBe(true);
    const files = await readdir(join(ctrlDir, 'tasks'));
    expect(files).toContain('l2-fixture-review.md');
    expect(files).toContain('l2-m7-pass.md');
    expect(files).toContain('l2-m7-human.md');
    expect(files).toContain('l2-m7-fail.md');
    expect(files).toContain('l2-m7-missing.md');
    const fixturePath = join(scratchDir, 'work', 'm7-review-fixture.json');
    expect((await stat(fixturePath)).mode & 0o777).toBe(0o600);
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      schema?: unknown;
      fixtureHash?: unknown;
      payload?: { tasks?: unknown[] };
    };
    expect(fixture.schema).toBe('hercules-m7-l2-review-fixture-envelope/v1');
    expect(fixture.fixtureHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fixture.payload?.tasks).toHaveLength(5); // 4 M7 scenes + l2-m7-pass-media (C3.24b)
    // Second call is a no-op (tasks present).
    expect(
      autoSeedL2FixtureIfNeeded(ctrlDir, {
        ...process.env,
        HERCULES_ADAPTER: 'fake',
      }),
    ).toBe(false);
  });

  it('autoSeed no-ops for non-fake adapter even when empty', async () => {
    await mkdir(join(ctrlDir, 'tasks'), { recursive: true });
    const ran = autoSeedL2FixtureIfNeeded(ctrlDir, {
      ...process.env,
      HERCULES_ADAPTER: 'grok',
    });
    expect(ran).toBe(false);
  });
});
