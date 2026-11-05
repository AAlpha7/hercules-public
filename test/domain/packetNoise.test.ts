import { describe, it, expect } from 'vitest';
import {
  foldNoiseAndMapDiff,
  isMapPath,
  isNoisePath,
  partitionFilesForPacket,
} from '../../src/domain/packetNoise.js';

describe('packetNoise', () => {
  it('classifies lockfiles and build dirs as noise', () => {
    expect(isNoisePath('pnpm-lock.yaml')).toBe(true);
    expect(isNoisePath('package-lock.json')).toBe(true);
    expect(isNoisePath('dist/index.js')).toBe(true);
    expect(isNoisePath('target/debug/orbit')).toBe(true);
    expect(isNoisePath('src/web/App.tsx')).toBe(false);
    expect(isNoisePath('docs/roadmap.md')).toBe(false);
  });

  it('classifies agent-map paths for diff folding (not file-list noise)', () => {
    expect(isMapPath('WORKFLOW.md')).toBe(true);
    expect(isMapPath('AGENTS.md')).toBe(true);
    expect(isMapPath('CLAUDE.md')).toBe(true);
    expect(isNoisePath('WORKFLOW.md')).toBe(false);
    expect(isMapPath('src/main.ts')).toBe(false);
  });

  it('partitions primary before noise, preserving order', () => {
    const { primary, noise } = partitionFilesForPacket([
      'src/a.ts',
      'pnpm-lock.yaml',
      'src/b.ts',
      'dist/out.js',
      'WORKFLOW.md',
    ]);
    expect(primary).toEqual(['src/a.ts', 'src/b.ts', 'WORKFLOW.md']);
    expect(noise).toEqual(['pnpm-lock.yaml', 'dist/out.js']);
  });

  it('folds map + noise hunks out of unified diffs', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/WORKFLOW.md b/WORKFLOW.md',
      '--- a/WORKFLOW.md',
      '+++ b/WORKFLOW.md',
      '@@ -1,50 +1,200 @@',
      '+huge',
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      '--- a/pnpm-lock.yaml',
      '+++ b/pnpm-lock.yaml',
      '@@ -1 +1 @@',
      '+lock',
    ].join('\n');
    const { primary, folded } = foldNoiseAndMapDiff(diff);
    expect(primary).toContain('src/a.ts');
    expect(primary).toContain('+new');
    expect(primary).not.toContain('WORKFLOW.md');
    expect(primary).not.toContain('pnpm-lock');
    expect(folded.map((f) => f.path).sort()).toEqual(['WORKFLOW.md', 'pnpm-lock.yaml'].sort());
    expect(folded.find((f) => f.path === 'WORKFLOW.md')?.reason).toBe('map');
    expect(folded.find((f) => f.path === 'pnpm-lock.yaml')?.reason).toBe('noise');
  });
});
