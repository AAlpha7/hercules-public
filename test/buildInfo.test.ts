import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clipboardBuildText,
  displayBuildLabel,
  formatBuildVersion,
  resolveBuildInfo,
  resetBuildInfoCache,
  currentBuildContains,
} from '../src/buildInfo.js';

afterEach(() => {
  resetBuildInfoCache();
});

describe('currentBuildContains', () => {
  it('requires clean ancestry and fails closed after tracked drift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hercules-build-attestation-'));
    const git = (...args: string[]): string => execFileSync('git', args, {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'Test');
      await writeFile(join(dir, 'control.txt'), 'one\n');
      git('add', 'control.txt');
      git('commit', '-qm', 'control baseline');
      const baseline = git('rev-parse', 'HEAD');
      await writeFile(join(dir, 'later.txt'), 'two\n');
      git('add', 'later.txt');
      git('commit', '-qm', 'later build');
      expect(currentBuildContains(baseline, dir)).toBe(true);
      await writeFile(join(dir, 'control.txt'), 'dirty\n');
      expect(currentBuildContains(baseline, dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('formatBuildVersion', () => {
  it('uses date + day push count (not git sha)', () => {
    expect(formatBuildVersion({ dateYmd: '20260713', dayPush: 1 })).toBe('v20260713.1');
    expect(formatBuildVersion({ dateYmd: '20260713', dayPush: 12 })).toBe('v20260713.12');
  });

  it('clamps dayPush to 1..999', () => {
    expect(formatBuildVersion({ dateYmd: '20260713', dayPush: 0 })).toBe('v20260713.1');
    expect(formatBuildVersion({ dateYmd: '20260713', dayPush: 5000 })).toBe('v20260713.999');
  });
});

describe('displayBuildLabel', () => {
  it('shows M/D · #N so the calendar day stays visible', () => {
    expect(displayBuildLabel('v20260713.3')).toBe('7/13 · #3');
    expect(displayBuildLabel('v20261201.1')).toBe('12/1 · #1');
  });
});

describe('clipboardBuildText', () => {
  it('joins version and sha for support copy', () => {
    expect(clipboardBuildText({ version: 'v20260713.3', gitSha: '4feeb8b' })).toBe(
      'v20260713.3 · 4feeb8b',
    );
  });
});

describe('resolveBuildInfo', () => {
  it('honors HERCULES_VERSION env override', () => {
    const info = resolveBuildInfo({
      HERCULES_VERSION: 'v20260101.7',
    } as NodeJS.ProcessEnv);
    expect(info.version).toBe('v20260101.7');
    expect(info.dayPush).toBe(7);
    expect(info.dateYmd).toBe('20260101');
  });
});
