/**
 * A task held by a failed/cancelled/missing dependency must SAY so on the
 * phone (vacuous-satisfaction fix, 2026-07-22) — otherwise it just sits in
 * todo forever and the human cannot tell why nothing dispatches.
 *
 * Gate-merge barrier holds (Approve-before-Merge) get their own banner with
 * stable data-evidence hooks and concise remediation.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('broken-dependency surfacing', () => {
  it('App computes brokenDependencies and TaskDetail renders the hold reason', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/brokenDependencies\(/);
    const detail = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(detail).toMatch(/brokenDeps/);
    expect(detail).toMatch(/data-evidence="blocked-deps"/);
    // Tells the human what unblocks it.
    expect(detail).toMatch(/Retry|blocked_by/);
  });

  it('surfaces merge-blocked deps with stable evidence + remediation', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/mergeBlockedDependencies\(/);
    const detail = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(detail).toMatch(/mergeBlockedDeps/);
    expect(detail).toMatch(/data-evidence="merge-blocked-deps"/);
    expect(detail).toMatch(/gate merge|Merge Selected/i);
  });
});
