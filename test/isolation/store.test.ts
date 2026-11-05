/**
 * SPEC §8.4: pnpm's content-addressed store hard-links node_modules across
 * worktrees ONLY when the store and the worktrees live on the same filesystem
 * (hard links can't cross devices → pnpm silently copies instead, and every
 * worktree duplicates node_modules on the constrained 2 OCPU / 12 GB box).
 * The daemon relies on pnpm's default global store, so this property holds by
 * luck of same-fs today — a boot check makes a regression loud, not silent.
 */
import { describe, it, expect } from 'vitest';
import { storeHardlinksAcrossWorktrees } from '../../src/isolation/store.js';

const stat = (dev: number) => () => ({ dev }) as { dev: number };

describe('storeHardlinksAcrossWorktrees', () => {
  it('true when store and work root share a filesystem device', () => {
    const r = storeHardlinksAcrossWorktrees('/store', '/work', (p) =>
      (p === '/store' ? stat(66)() : stat(66)()),
    );
    expect(r.ok).toBe(true);
  });

  it('false (would duplicate) when they are on different devices', () => {
    const r = storeHardlinksAcrossWorktrees('/store', '/work', (p) =>
      (p === '/store' ? stat(66)() : stat(99)()),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/different filesystem|cross-device|duplicat/i);
  });

  it('ok (does not block boot) when a path cannot be stat-ed yet', () => {
    const r = storeHardlinksAcrossWorktrees('/store', '/work', () => {
      throw new Error('ENOENT');
    });
    expect(r.ok).toBe(true); // unknown → don't false-alarm; store/work created lazily
    expect(r.reason).toMatch(/could not|unknown/i);
  });
});
