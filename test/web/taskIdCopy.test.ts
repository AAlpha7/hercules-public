/**
 * Tap the task id (task sheet meta row) → copies the id to the clipboard
 * with a brief "copied" flash. Copy logic is shared (clipboard.ts) with the
 * version-stamp copier — iOS/plain-http needs the execCommand fallback.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('task id tap-to-copy', () => {
  it('shared clipboard helper exists with execCommand fallback', async () => {
    const src = await readFile(join(ROOT, 'src/web/clipboard.ts'), 'utf8');
    expect(src).toMatch(/export async function copyToClipboard/);
    expect(src).toMatch(/navigator\.clipboard/);
    expect(src).toMatch(/execCommand\('copy'\)/);
  });

  it('TaskDetail id copies on tap and flashes confirmation', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/copyToClipboard\(task\.id\)/);
    expect(src).toMatch(/idCopied/);
  });

  it('version stamp reuses the shared helper (no duplicated fallback)', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/copyToClipboard\(/);
    expect(app).not.toMatch(/execCommand\('copy'\)/);
  });
});
