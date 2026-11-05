/**
 * UX contract: exclusive modes use SegmentedControl, not checkboxes / long selects.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('segmented controls (phone UX)', () => {
  it('CreateForm uses Task|Pipeline segments instead of a pipeline checkbox', async () => {
    const src = await readFile(join(ROOT, 'src/web/CreateForm.tsx'), 'utf8');
    expect(src).toMatch(/SegmentedControl/);
    expect(src).toMatch(/value: 'task'/);
    expect(src).toMatch(/value: 'pipeline'/);
    expect(src).not.toMatch(/pipeline-mode-toggle/);
    expect(src).not.toMatch(/Multi-step pipeline \(blocked_by/);
  });

  it('in-progress agent switch exposes Later / Now actions', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toContain("'Later'");
    expect(src).toMatch(/stop & re-queue/);
    expect(src).toMatch(/switchNow: true/);
  });

  it('delete offers Delete vs Delete & clean (no cleanup checkbox)', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/Delete & clean/);
    expect(src).toMatch(/onDelete\(true\)/);
    expect(src).toMatch(/onDelete\(false\)/);
    expect(src).not.toMatch(/delete-cleanup-opt/);
  });

  it('SessionsPanel permission modes use SegmentedControl', async () => {
    const src = await readFile(join(ROOT, 'src/web/SessionsPanel.tsx'), 'utf8');
    expect(src).toMatch(/SegmentedControl/);
    expect(src).toMatch(/ariaLabel=["']Permission mode["']/);
    // Permissions no longer use a <select> (agent/repo still may).
    expect(src).not.toMatch(/Permissions mode/);
    expect(src).not.toMatch(/setPermissionMode\(e\.target\.value/);
  });
});
