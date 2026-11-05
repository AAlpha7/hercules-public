/**
 * Release-ops kill switch (2026-07-18): the staging daemon runs the same
 * binary but must be a verification TARGET, not a release controller — its
 * reconciler was double-deploying staging (self-restart loop) and its
 * promote service could have driven a REAL production deploy from the
 * staging UI. HERCULES_RELEASE_OPS=0 disables both.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('HERCULES_RELEASE_OPS wiring', () => {
  it('gates both the release reconciler and the promote service in main.ts', async () => {
    const src = await readFile(join(ROOT, 'src/main.ts'), 'utf8');
    expect(src).toMatch(/HERCULES_RELEASE_OPS/);
    // FAIL-CLOSED: explicit === '1', never a negative check — a missing env
    // var on a fresh instance must NOT enable production-deploy capability.
    const releaseOpsVar = /const releaseOpsOn = process\.env\['HERCULES_RELEASE_OPS'\] === '1'/;
    expect(src).toMatch(releaseOpsVar);
    // Both constructions must consult the flag.
    expect(src).toMatch(/releaseOpsOn &&[\s\S]{0,80}new ReleaseReconciler|releaseOpsOn\s*\?[\s\S]{0,120}new ReleaseReconciler|releaseOpsOn &&(?:[\s\S]{0,120})ReleaseReconciler/);
    expect(src).toMatch(/releaseOpsOn(?:[\s\S]{0,160})new PromoteService/);
  });
});
