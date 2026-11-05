/**
 * Running tasks: live activity is the primary surface (above body), not buried.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('live activity layout (running tasks)', () => {
  it('places live panel before task body and uses sticky primary surface', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    const helpers = await readFile(join(ROOT, 'src/web/taskUi.ts'), 'utf8');
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');

    const briefIdx = src.indexOf('run-brief-panel');
    const liveIdx = src.indexOf('activity-panel-live');
    const bodyIdx = src.indexOf("task.state === 'in_progress'\n                ? 'Task body (expand)'");
    expect(briefIdx, 'run brief panel').toBeGreaterThan(0);
    expect(liveIdx, 'live panel marker').toBeGreaterThan(0);
    expect(bodyIdx, 'collapsed body while running').toBeGreaterThan(0);
    expect(briefIdx).toBeLessThan(liveIdx);
    expect(liveIdx).toBeLessThan(bodyIdx);

    // Empty state should not look like a hang-only "waiting for output"
    expect(src).toMatch(/Agent is running/);
    expect(src).not.toMatch(/waiting for output…/);
    expect(src).toMatch(/What this run is for/);
    expect(src).toMatch(/extractTaskSummary/);
    expect(src).toMatch(/liveRun\?\.branchTip/);
    expect(src).toMatch(/verification active/);
    expect(src).toMatch(/agent active/);
    expect(src).not.toMatch(/liveRun\?\.sessionId/);
    expect(src).not.toMatch(/task\.agentSession/);
    // Quiet progress: processAlive silence must be visible (cargo case study)
    expect(src).toMatch(/liveStatusPill/);
    expect(helpers).toMatch(/liveStatusPill/);
    expect(helpers).toMatch(/pill-quiet|QUIET/);
    expect(src).toMatch(/process alive/);
    expect(src).toMatch(/hard kill/);
    expect(src).toMatch(/aliveHint/);

    expect(css).toMatch(/\.activity-panel-live\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/\.run-brief-panel/);
    expect(css).toMatch(/\.pill-quiet/);
    expect(css).toMatch(/\.activity-panel-quiet/);
  });
});
