import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  detectBaseDrift,
  tryRebaseOntoDefault,
  detectBaseDriftWithOptionalRebase,
} from '../../src/isolation/baseDrift.js';

let dir: string;

async function initRepo(): Promise<ReturnType<typeof simpleGit>> {
  dir = await mkdtemp(join(tmpdir(), 'hercules-base-drift-'));
  const g = simpleGit(dir);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  await g.add('.');
  await g.commit('base');
  return g;
}

beforeEach(async () => {
  await initRepo();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectBaseDrift (diverging branches in temp repos)', { timeout: 20_000 }, () => {
  it('reports current when HEAD is the default tip', async () => {
    const r = await detectBaseDrift(dir, 'main');
    expect(r.status).toBe('current');
    expect(r.behind).toBe(0);
    expect(r.ahead).toBe(0);
    expect(r.conflictRisk).toBe('none');
    expect(r.mergeBase).toMatch(/^[0-9a-f]+$/i);
  });

  it('reports behind when main advanced and feature did not', async () => {
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('hercules/T-1');
    await writeFile(join(dir, 'feat.txt'), 'feat\n');
    await g.add('.');
    await g.commit('feat work');

    await g.checkout('main');
    await writeFile(join(dir, 'main-only.txt'), 'from main\n');
    await g.add('.');
    await g.commit('main advances');
    await g.checkout('hercules/T-1');

    const r = await detectBaseDrift(dir, 'main');
    expect(r.behind).toBe(1);
    expect(r.ahead).toBe(1);
    expect(r.status).toBe('diverged');
    expect(r.conflictRisk).toBe('none'); // non-overlapping files
  });

  it('reports conflict risk when same file diverged', async () => {
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('hercules/T-2');
    await writeFile(join(dir, 'base.txt'), 'feature edit\n');
    await g.add('.');
    await g.commit('feat: touch base');

    await g.checkout('main');
    await writeFile(join(dir, 'base.txt'), 'main edit\n');
    await g.add('.');
    await g.commit('main: touch base');
    await g.checkout('hercules/T-2');

    const r = await detectBaseDrift(dir, 'main');
    expect(r.behind).toBeGreaterThan(0);
    expect(r.ahead).toBeGreaterThan(0);
    expect(r.conflictRisk).toBe('conflict');
    expect(r.conflictDetail ?? '').toMatch(/CONFLICT|base\.txt/i);
  });

  it('does not modify main tip while probing', async () => {
    const g = simpleGit(dir);
    const mainBefore = (await g.raw(['rev-parse', 'main'])).trim();
    await g.checkoutLocalBranch('hercules/T-3');
    await writeFile(join(dir, 'x.txt'), 'x\n');
    await g.add('.');
    await g.commit('x');
    await g.checkout('main');
    await writeFile(join(dir, 'y.txt'), 'y\n');
    await g.add('.');
    await g.commit('y');
    const mainMid = (await g.raw(['rev-parse', 'main'])).trim();
    await g.checkout('hercules/T-3');

    await detectBaseDrift(dir, 'main');
    const mainAfter = (await g.raw(['rev-parse', 'main'])).trim();
    expect(mainAfter).toBe(mainMid);
    expect(mainAfter).not.toBe(mainBefore);
    // Still on task branch.
    const branch = (await g.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    expect(branch).toBe('hercules/T-3');
  });
});

describe('tryRebaseOntoDefault', { timeout: 20_000 }, () => {
  it('rebases a clean lagging feature onto main (no force-push, main unchanged)', async () => {
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('hercules/T-4');
    await writeFile(join(dir, 'feat.txt'), 'feat\n');
    await g.add('.');
    await g.commit('feat');

    await g.checkout('main');
    await writeFile(join(dir, 'main-only.txt'), 'main\n');
    await g.add('.');
    await g.commit('main advances');
    const mainTip = (await g.raw(['rev-parse', 'main'])).trim();
    await g.checkout('hercules/T-4');

    const result = await tryRebaseOntoDefault(dir, 'main');
    expect(result.ok).toBe(true);
    expect((await g.raw(['rev-parse', 'main'])).trim()).toBe(mainTip);
    // After rebase, feature is no longer behind.
    const drift = await detectBaseDrift(dir, 'main');
    expect(drift.behind).toBe(0);
    expect(drift.ahead).toBeGreaterThan(0);
  });

  it('resolves content conflict with -X ours (prefer default) on second pass', async () => {
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('hercules/T-5');
    await writeFile(join(dir, 'base.txt'), 'feature\n');
    await writeFile(join(dir, 'feat-only.txt'), 'keep\n');
    await g.add('.');
    await g.commit('feat conflict');

    await g.checkout('main');
    await writeFile(join(dir, 'base.txt'), 'main\n');
    await g.add('.');
    await g.commit('main conflict');
    const mainTip = (await g.raw(['rev-parse', 'main'])).trim();
    await g.checkout('hercules/T-5');

    const result = await tryRebaseOntoDefault(dir, 'main');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/-X ours|ours/i);
    // Default branch tip unchanged; product-only file retained.
    expect((await g.raw(['rev-parse', 'main'])).trim()).toBe(mainTip);
    expect(await readFile(join(dir, 'base.txt'), 'utf8')).toBe('main\n');
    expect(await readFile(join(dir, 'feat-only.txt'), 'utf8')).toBe('keep\n');
    const branch = (await g.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    expect(branch).toBe('hercules/T-5');
    const drift = await detectBaseDrift(dir, 'main');
    expect(drift.behind).toBe(0);
  });
});

describe('detectBaseDriftWithOptionalRebase', { timeout: 20_000 }, () => {
  it('leaves the branch alone when autoRebase is off (default)', async () => {
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('hercules/T-6');
    await writeFile(join(dir, 'f.txt'), 'f\n');
    await g.add('.');
    await g.commit('f');
    await g.checkout('main');
    await writeFile(join(dir, 'm.txt'), 'm\n');
    await g.add('.');
    await g.commit('m');
    await g.checkout('hercules/T-6');
    const tip = (await g.raw(['rev-parse', 'HEAD'])).trim();

    const r = await detectBaseDriftWithOptionalRebase(dir, 'main', { autoRebase: false });
    expect(r.behind).toBe(1);
    expect(r.rebaseAttempted).toBe(false);
    expect((await g.raw(['rev-parse', 'HEAD'])).trim()).toBe(tip);
  });

  it('auto-rebases then reports current/ahead when clean', async () => {
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('hercules/T-7');
    await writeFile(join(dir, 'f.txt'), 'f\n');
    await g.add('.');
    await g.commit('f');
    await g.checkout('main');
    await writeFile(join(dir, 'm.txt'), 'm\n');
    await g.add('.');
    await g.commit('m');
    await g.checkout('hercules/T-7');

    const r = await detectBaseDriftWithOptionalRebase(dir, 'main', { autoRebase: true });
    expect(r.rebaseAttempted).toBe(true);
    expect(r.rebaseOk).toBe(true);
    expect(r.behind).toBe(0);
    expect(r.status === 'ahead' || r.status === 'current').toBe(true);
  });

  it('auto-rebase conflict recovers via -X ours without touching main', async () => {
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('hercules/T-8');
    await writeFile(join(dir, 'base.txt'), 'feature\n');
    await g.add('.');
    await g.commit('feat');
    await g.checkout('main');
    await writeFile(join(dir, 'base.txt'), 'main\n');
    await g.add('.');
    await g.commit('main');
    const mainTip = (await g.raw(['rev-parse', 'main'])).trim();
    await g.checkout('hercules/T-8');

    const r = await detectBaseDriftWithOptionalRebase(dir, 'main', { autoRebase: true });
    expect(r.rebaseAttempted).toBe(true);
    expect(r.rebaseOk).toBe(true);
    expect(r.behind).toBe(0);
    expect(r.rebaseDetail ?? '').toMatch(/ours/i);
    expect((await g.raw(['rev-parse', 'main'])).trim()).toBe(mainTip);
  });
});
