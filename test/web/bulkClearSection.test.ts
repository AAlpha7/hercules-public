/**
 * Task list: bulk clear a state kind — muted utility → Clear → confirm (red only armed).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('task list bulk clear by kind', () => {
  it('collapses to muted affordance (not red badge); expand then ConfirmButton clear', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    const panel = await readFile(join(ROOT, 'src/web/TasksPanel.tsx'), 'utf8');
    const helpers = await readFile(join(ROOT, 'src/web/taskUi.ts'), 'utf8');
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    // Orchestration stays in App; chrome lives on TasksPanel.
    expect(app).toMatch(/bulkDeleteTasks/);
    expect(app).toMatch(/bulkPending/);
    expect(app).toMatch(/TasksPanel/);
    expect(helpers).toMatch(/canBulkDeleteState/);
    expect(helpers).toMatch(/s !== 'in_progress' && s !== 'retrying'/);
    expect(panel).toMatch(/SectionClearControl/);
    expect(panel).toMatch(/section-clear-affordance/);
    expect(panel).toMatch(/section-clear-btn/);
    expect(panel).not.toMatch(/section-clear-dot/);
    // Idle Clear is not danger; red only via confirm-armed
    expect(panel).not.toMatch(/section-clear-btn danger/);
    // Three-phase: muted affordance → Clear → Delete N?
    expect(panel).toMatch(/setExpanded\(true\)/);
    expect(panel).toMatch(/confirmLabel=\{`Delete \$\{count\}\?`\}/);
    expect(panel).toMatch(/label="Clear"/);
    expect(css).toMatch(/section-clear-affordance/);
    expect(css).not.toMatch(/section-clear-dot/);
  });
});
