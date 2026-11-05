/**
 * Structural contract: overrideNote stays on the client API + L2 hook.
 * Interaction (disabled until ≥10 chars, payload fields) lives in
 * test/web/render/taskDetailOverride.render.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('override approve wiring', () => {
  it('client api approve carries overrideNote', async () => {
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(api).toMatch(/overrideNote/);
  });

  it('TaskDetail exposes open override-approve evidence hook', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/data-evidence="override-approve"/);
    // Open by default — a collapsed footnote read as a dead end (2026-07-23).
    expect(src).toMatch(/override-approve" open|open data-evidence="override-approve"/);
  });
});
