/**
 * Operator MCP smoke harness — close-vs-exit race contract.
 *
 * Staging observed empty stdout when the harness awaited child `exit` and
 * inspected the accumulator before stdio streams had fully closed. The smoke
 * must wait for `close`, reject non-zero/signaled termination, and only then
 * read stdout.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SMOKE = join(ROOT, 'scripts/smoke-mcp-workspace.mjs');

describe('scripts/smoke-mcp-workspace.mjs (stdout close race)', () => {
  it('waits for child close (not merely exit), rejects bad status, then inspects stdout', async () => {
    const src = await readFile(SMOKE, 'utf8');

    // Must await stdio closure — `exit` can fire while stdout is still open.
    expect(src).toMatch(/child\.on\(\s*['"]close['"]/);
    // Must not complete the child wait on exit alone (the historical flake).
    expect(src).not.toMatch(/child\.on\(\s*['"]exit['"]/);

    // Non-zero exit or signal must fail with a diagnostic (not silent success).
    expect(src).toMatch(/\bsignal\b/);
    expect(src).toMatch(/code\s*!==\s*0/);
    expect(src).toMatch(/throw new Error\s*\(/);

    // Stdout content check must appear after the close wait, not before.
    const closeAt = src.search(/child\.on\(\s*['"]close['"]/);
    expect(closeAt).toBeGreaterThanOrEqual(0);
    const outCheckAt = src.search(/out\.includes\s*\(/);
    expect(outCheckAt).toBeGreaterThan(closeAt);
  });
});
