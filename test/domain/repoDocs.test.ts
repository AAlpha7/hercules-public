/**
 * Pure filters for the repo docs browser: which paths from a git tree count
 * as browsable documentation (not every source file).
 */
import { describe, it, expect } from 'vitest';
import {
  isRepoDocPath,
  isSafeRepoDocRelPath,
  filterRepoDocPaths,
  splitRepoDocEntrypoints,
  filterDocsByQuery,
} from '../../src/domain/repoDocs.js';

describe('isRepoDocPath', () => {
  it('accepts common root docs and docs/**/*.md', () => {
    expect(isRepoDocPath('README.md')).toBe(true);
    expect(isRepoDocPath('readme.md')).toBe(true);
    expect(isRepoDocPath('AGENTS.md')).toBe(true);
    expect(isRepoDocPath('CLAUDE.md')).toBe(true);
    expect(isRepoDocPath('WORKFLOW.md')).toBe(true);
    expect(isRepoDocPath('SPEC.md')).toBe(true);
    expect(isRepoDocPath('CONTRIBUTING.md')).toBe(true);
    expect(isRepoDocPath('CHANGELOG.md')).toBe(true);
    expect(isRepoDocPath('docs/deploy.md')).toBe(true);
    expect(isRepoDocPath('docs/plans/x.md')).toBe(true);
  });

  it('rejects source, lockfiles, and non-markdown under docs', () => {
    expect(isRepoDocPath('src/main.ts')).toBe(false);
    expect(isRepoDocPath('package.json')).toBe(false);
    expect(isRepoDocPath('docs/logo.png')).toBe(false);
    expect(isRepoDocPath('test/foo.test.ts')).toBe(false);
  });
});

describe('isSafeRepoDocRelPath', () => {
  it('rejects traversal, absolute, empty, and null bytes', () => {
    expect(isSafeRepoDocRelPath('../etc/passwd')).toBe(false);
    expect(isSafeRepoDocRelPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoDocRelPath('')).toBe(false);
    expect(isSafeRepoDocRelPath('docs/../secret')).toBe(false);
    expect(isSafeRepoDocRelPath('docs\\x.md')).toBe(false);
    expect(isSafeRepoDocRelPath('docs/\0x.md')).toBe(false);
  });

  it('accepts clean relative markdown paths', () => {
    expect(isSafeRepoDocRelPath('README.md')).toBe(true);
    expect(isSafeRepoDocRelPath('docs/deploy.md')).toBe(true);
  });
});

describe('filterRepoDocPaths', () => {
  it('filters + sorts for stable UI order (root first, then docs/)', () => {
    const out = filterRepoDocPaths([
      'src/a.ts',
      'docs/z.md',
      'README.md',
      'docs/a.md',
      'package.json',
    ]);
    expect(out).toEqual(['README.md', 'docs/a.md', 'docs/z.md']);
  });
});

describe('splitRepoDocEntrypoints', () => {
  it('pins entry docs in fixed order and leaves the rest', () => {
    const out = splitRepoDocEntrypoints([
      'docs/z.md',
      'SECURITY.md',
      'docs/a.md',
      'CLAUDE.md',
      'README.md',
      'AGENTS.md',
      'WORKFLOW.md',
      'CONTRIBUTING.md',
      'SPEC.md',
    ]);
    expect(out.entrypoints).toEqual([
      'README.md',
      'AGENTS.md',
      'WORKFLOW.md',
      'CLAUDE.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
    ]);
    expect(out.rest).toEqual(['docs/z.md', 'docs/a.md', 'SPEC.md']);
  });

  it('omits missing entry files and keeps only present pins', () => {
    const out = splitRepoDocEntrypoints([
      'docs/2026-04-21-plan.md',
      'AGENTS.md',
      'readme.md',
    ]);
    expect(out.entrypoints).toEqual(['readme.md', 'AGENTS.md']);
    expect(out.rest).toEqual(['docs/2026-04-21-plan.md']);
  });

  it('does not pin nested docs/README.md as an entrypoint', () => {
    const out = splitRepoDocEntrypoints(['docs/README.md', 'SPEC.md']);
    expect(out.entrypoints).toEqual([]);
    expect(out.rest).toEqual(['docs/README.md', 'SPEC.md']);
  });
});

describe('filterDocsByQuery', () => {
  const sample = [
    'README.md',
    'docs/Deploy.md',
    'docs/2026-04-21-plan.md',
    'AGENTS.md',
  ] as const;

  it('matches path substrings case-insensitively', () => {
    expect(filterDocsByQuery(sample, 'deploy')).toEqual(['docs/Deploy.md']);
    expect(filterDocsByQuery(sample, 'AGENTS')).toEqual(['AGENTS.md']);
    expect(filterDocsByQuery(sample, '2026-04')).toEqual(['docs/2026-04-21-plan.md']);
  });

  it('returns all paths for empty/whitespace query', () => {
    expect(filterDocsByQuery(sample, '')).toEqual([...sample]);
    expect(filterDocsByQuery(sample, '   ')).toEqual([...sample]);
  });

  it('returns empty when nothing matches', () => {
    expect(filterDocsByQuery(sample, 'zzz-nope')).toEqual([]);
  });
});
