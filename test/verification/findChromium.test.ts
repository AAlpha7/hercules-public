/**
 * Pure resolve tests for findChromium / requireChromium (no real browser).
 * Covers Playwright cache rotation and exact-reason miss messages.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserUnavailableError,
  ChromiumDriver,
  clearChromiumResolveCache,
  findChromium,
  requireChromium,
  scanChromium,
} from '../../src/verification/browser.js';

function plantChrome(
  cacheDir: string,
  entry: string,
  binary: 'chrome' | 'headless_shell',
): string {
  const candidate = join(cacheDir, entry, 'chrome-linux', binary);
  mkdirSync(join(cacheDir, entry, 'chrome-linux'), { recursive: true });
  writeFileSync(candidate, '#!/bin/sh\n', { mode: 0o755 });
  return candidate;
}

describe('findChromium resolve-at-use', () => {
  beforeEach(() => {
    clearChromiumResolveCache();
  });
  afterEach(() => {
    clearChromiumResolveCache();
  });

  it('honors the HERCULES_CHROMIUM override', () => {
    const prev = process.env['HERCULES_CHROMIUM'];
    process.env['HERCULES_CHROMIUM'] = '/custom/headless_shell';
    try {
      expect(findChromium()).toBe('/custom/headless_shell');
    } finally {
      if (prev === undefined) delete process.env['HERCULES_CHROMIUM'];
      else process.env['HERCULES_CHROMIUM'] = prev;
    }
  });

  it('rescans when a previously resolved path disappears and finds the new version', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'ms-playwright-'));
    try {
      const oldBin = plantChrome(cacheDir, 'chromium-1000', 'chrome');
      const first = findChromium({ cacheDir, now: () => 1_000 });
      expect(first).toBe(oldBin);

      // Playwright cache rotation: old revision removed, new revision installed.
      await rm(join(cacheDir, 'chromium-1000'), { recursive: true, force: true });
      const newBin = plantChrome(cacheDir, 'chromium-2000', 'chrome');

      // Still inside TTL (now=1500 < expiresAt=61000) — existence miss forces rescan.
      const second = findChromium({ cacheDir, now: () => 1_500 });
      expect(second).toBe(newBin);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('requireChromium error includes scanned directory and candidates when all missing', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'ms-playwright-empty-'));
    try {
      mkdirSync(join(cacheDir, 'chromium-999', 'chrome-linux'), { recursive: true });
      mkdirSync(join(cacheDir, 'chromium_headless_shell-998', 'chrome-linux'), {
        recursive: true,
      });
      writeFileSync(join(cacheDir, 'ffmpeg-1'), 'not-a-browser');

      const scan = scanChromium({ cacheDir });
      expect(scan.path).toBeNull();
      expect(scan.cacheDir).toBe(cacheDir);
      expect(scan.entries).toEqual(
        expect.arrayContaining(['chromium-999', 'chromium_headless_shell-998', 'ffmpeg-1']),
      );

      expect(() => requireChromium({ cacheDir })).toThrow(BrowserUnavailableError);
      try {
        requireChromium({ cacheDir });
        expect.unreachable('requireChromium should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BrowserUnavailableError);
        const msg = (err as Error).message;
        expect(msg).toContain(cacheDir);
        expect(msg).toContain('chromium-999');
        expect(msg).toContain('chromium_headless_shell-998');
        expect(msg).toMatch(/chrome-linux\/(chrome|headless_shell)/);
        expect(msg).toMatch(/HERCULES_CHROMIUM|playwright install/i);
      }
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('ChromiumDriver constructor does not bind path; use-time miss includes scan detail', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'ms-playwright-driver-'));
    try {
      mkdirSync(join(cacheDir, 'chromium-1', 'chrome-linux'), { recursive: true });
      // Construct while unusable — must not throw at construction time.
      const driver = new ChromiumDriver({ cacheDir });
      await expect(driver.domSnapshot('data:text/html,<p>x</p>')).rejects.toThrow(
        BrowserUnavailableError,
      );
      await expect(driver.domSnapshot('data:text/html,<p>x</p>')).rejects.toThrow(
        /chromium-1|chrome-linux/,
      );
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
