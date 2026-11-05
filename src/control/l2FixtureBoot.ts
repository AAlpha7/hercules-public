/**
 * L2 isolation: when the trusted-mirror WORKFLOW still empty-seeds ctrl/
 * (`repos: {}` + no tasks), the worktree build auto-seeds the realistic
 * fixture so Decision / Mark-ready chrome is real — without placeholder
 * data-evidence hosts in production src/web.
 *
 * Safe by design:
 *   - Only when HERCULES_ADAPTER=fake (L2 isolation / dry-run).
 *   - Only when the control plane has zero task files (empty plane).
 *   - Writes only under the given control dir (scratch in L2).
 *   - No-op when WORKFLOW already ran scripts/l2-seed-control-fixture.mjs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when this process should fill an empty L2 control plane. */
export function shouldAutoSeedL2Fixture(input: {
  readonly adapter: string;
  readonly controlDir: string;
}): boolean {
  if (input.adapter.trim().toLowerCase() !== 'fake') return false;
  const tasksDir = join(input.controlDir, 'tasks');
  if (!existsSync(tasksDir)) return true;
  try {
    const files = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    return files.length === 0;
  } catch {
    return true;
  }
}

/** Resolve scripts/l2-seed-control-fixture.mjs from this package (src or dist). */
export function resolveL2SeedScriptPath(
  fromUrl: string = import.meta.url,
): string {
  // dist/src/control → ../../.. = package root; src/control → ../.. = package root
  const here = dirname(fileURLToPath(fromUrl));
  const candidates = [
    join(here, '..', '..', '..', 'scripts', 'l2-seed-control-fixture.mjs'),
    join(here, '..', '..', 'scripts', 'l2-seed-control-fixture.mjs'),
    join(process.cwd(), 'scripts', 'l2-seed-control-fixture.mjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[candidates.length - 1]!;
}

/**
 * If empty + fake, run the seed script. Returns true when seeding ran.
 * Throws when seed is required but the script fails (fail loud — empty plane
 * would greenwash L2 again).
 */
export function autoSeedL2FixtureIfNeeded(
  controlDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const adapter = (env['HERCULES_ADAPTER'] ?? 'grok').trim();
  if (!shouldAutoSeedL2Fixture({ adapter, controlDir })) return false;
  const script = resolveL2SeedScriptPath();
  if (!existsSync(script)) {
    throw new Error(
      `L2 empty-plane auto-seed: missing ${script} (cannot fill fixture control plane)`,
    );
  }
  execFileSync(process.execPath, [script, controlDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.error(
    `[hercules] L2 fixture auto-seeded empty control plane at ${controlDir}`,
  );
  return true;
}
