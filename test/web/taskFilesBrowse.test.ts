/**
 * Phone review file browser: "Spot-check docs quality" was unactionable —
 * nothing on the phone could show the produced files' content (2026-07-22).
 * TaskDetail gains a Browse-files disclosure backed by the verified-sha
 * mirror routes.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('task files browser wiring', () => {
  it('client api exposes fetchTaskFiles/fetchTaskFile', async () => {
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(api).toMatch(/export const fetchTaskFiles/);
    expect(api).toMatch(/export const fetchTaskFile /);
    expect(api).toMatch(/\/files/);
    expect(api).toMatch(/encodeURIComponent\(path\)/);
  });

  it('TaskDetail renders a browse-files disclosure with markdown file view', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/data-evidence="task-files"/);
    expect(src).toMatch(/fetchTaskFiles\(/);
    expect(src).toMatch(/fetchTaskFile\(/);
    // Markdown files render as markdown; others as preformatted text.
    expect(src).toMatch(/\.md['"`]?\)?\s*\?|endsWith\(['"`]\.md/);
  });
});
