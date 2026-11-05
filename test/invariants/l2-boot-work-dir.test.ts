/**
 * A4 — L2 setup.boot must override HERCULES_WORK_DIR to a scratch path.
 *
 * Historical production worktree wipe (2026-07-15/17): the L2 boot subprocess
 * inherited the live daemon's work root and reclaimOrphans deleted every live
 * worktree. The rule lived in WORKFLOW.md comments. This invariant locks the
 * boot *recipe* (the command under setup.boot), not the comment above it.
 *
 * Read files, assert strings. No mocks, no network, no Guardian/bwrap stub.
 * Does not change /api, architecture, PATH_LEASE_PROCESS_PROBE, or deploy.
 * Does not rewrite WORKFLOW boot semantics — it fails if the override drops.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Current recipe: isolated instance work root is the scratch sibling of ctrl. */
const SCRATCH_WORK_DIR_ASSIGNMENT = 'HERCULES_WORK_DIR={scratch_dir}/work';

function extractFrontMatter(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  expect(match, 'WORKFLOW.md must have YAML front matter').not.toBeNull();
  return match![1]!;
}

const SETUP_BOOT_KEY = '  boot:';

/** `setup.boot` list only — comments above `boot:` are excluded on purpose. */
function extractSetupBootBlock(frontMatter: string): string {
  const bootAt = frontMatter.search(/^ {2}boot:/m);
  expect(bootAt, 'WORKFLOW.md setup.boot must exist').toBeGreaterThan(-1);
  const fromBoot = frontMatter.slice(bootAt);
  const rest = fromBoot.slice(SETUP_BOOT_KEY.length);
  const nextKey = rest.search(/^\s{0,2}[a-z_]+:/m);
  return nextKey === -1 ? fromBoot : fromBoot.slice(0, SETUP_BOOT_KEY.length + nextKey);
}

describe('L2 boot recipe overrides HERCULES_WORK_DIR', () => {
  it('setup.boot assigns HERCULES_WORK_DIR to the scratch work path', async () => {
    const workflow = await readFile(join(ROOT, 'WORKFLOW.md'), 'utf8');
    const boot = extractSetupBootBlock(extractFrontMatter(workflow));

    expect(boot, 'setup.boot must start the isolated instance').toMatch(
      /node dist\/src\/main\.js/,
    );
    expect(
      boot,
      'setup.boot recipe must override HERCULES_WORK_DIR (not inherit the live work root)',
    ).toContain(SCRATCH_WORK_DIR_ASSIGNMENT);
    expect(
      boot,
      'HERCULES_WORK_DIR override must apply to the isolated node dist/src/main.js process',
    ).toMatch(/HERCULES_WORK_DIR=\{scratch_dir\}\/work[\s\S]*?node dist\/src\/main\.js/);

    expect(boot, 'L2 boot must not point at the production work root').not.toMatch(
      /HERCULES_WORK_DIR=\/home\/ubuntu\/hercules-work-live/,
    );
  });

  it('seed script stays aligned with the scratch work-root convention', async () => {
    const seed = await readFile(join(ROOT, 'scripts/l2-seed-control-fixture.mjs'), 'utf8');
    expect(seed, 'seed script must document the WORKFLOW scratch assignment').toContain(
      SCRATCH_WORK_DIR_ASSIGNMENT,
    );
    expect(seed, 'seed script must resolve the sibling scratch work root').toMatch(
      /join\(ctrlDir, '\.\.', 'work'\)/,
    );
  });
});
