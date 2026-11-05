import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromiumDriver, findChromium } from '../../src/verification/browser.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hasBrowser = findChromium() !== null;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hercules-browser-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// These run only where a Chromium headless shell is installed (e.g. this box).
// Pure resolve / cache-rotation coverage lives in findChromium.test.ts (unit suite).
describe.skipIf(!hasBrowser)('ChromiumDriver (real headless Chromium)', () => {
  it('navigates and writes a PNG screenshot', async () => {
    const out = join(dir, 'shot.png');
    await new ChromiumDriver().screenshot(
      'data:text/html,<h1>Hercules</h1>',
      out,
      { width: 200, height: 120 },
    );
    const buf = await readFile(out);
    expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(buf.length).toBeGreaterThan(100);
  }, 30000);

  it('returns the rendered DOM via domSnapshot', async () => {
    const dom = await new ChromiumDriver().domSnapshot('data:text/html,<h1>marker-xyz</h1>');
    expect(dom).toContain('marker-xyz');
  }, 30000);
});
