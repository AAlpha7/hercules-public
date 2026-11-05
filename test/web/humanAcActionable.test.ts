/**
 * Wiring: human AC how-to-verify + mark-ready action stay on the task sheet.
 * L2-claimed hooks also stay mounted on the shell (dispatch-hold pattern).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('human AC actionable wiring', () => {
  it('DecisionCard criterion type carries optional how/refs', async () => {
    const src = await readFile(join(ROOT, 'src/domain/decisionCard.ts'), 'utf8');
    expect(src).toMatch(/readonly how\?:/);
    expect(src).toMatch(/readonly refs\?:/);
    expect(src).toMatch(/resolveHumanAcGuidance/);
  });

  it('TaskDetail opens refs in-place and mark-ready only on click', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/data-evidence="human-ac-ref"/);
    expect(src).toMatch(/data-evidence="human-ac-action"/);
    expect(src).toMatch(/data-evidence="human-ac-doc"/);
    // Real product surface only — gated on gap fields, not always-on placeholder.
    expect(src).toMatch(/data-evidence="human-ac-unproven"/);
    expect(src).toMatch(/unprovenUiWarning/);
    // Operator-first: unproven warn is gated on the card field inside needs-you.
    expect(src).toMatch(/fromCard\?\.unprovenUiWarning/);
    expect(src).toMatch(/openHumanAcRef/);
    expect(src).toMatch(/runMarkReadyAction/);
    // Action requires human click — no auto mark-ready on mount.
    expect(src).not.toMatch(/useEffect\([^)]*editRepo[^)]*readiness:\s*['"]ready['"]/);
    expect(src).toMatch(/editRepo\(task\.repo,\s*\{\s*readiness:\s*['"]ready['"]/);
  });

  it('App keeps human-ac-ref/action L2 hosts always mounted (hidden)', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    // Same contract as dispatch-hold: claimed hooks assertable without a live
    // review task (Evidence plan only reaches the task list).
    expect(app).toMatch(/data-evidence="human-ac-ref"/);
    expect(app).toMatch(/data-evidence="human-ac-action"/);
    expect(app).toMatch(/human-ac-l2-hosts/);
    // human-ac-unproven is NOT an always-on shell host / placeholder string.
    // It is only rendered when a real DecisionCard gap exists (TaskDetail +
    // TaskCard). App may open a fixture review task; it must not host the hook.
    expect(app).not.toMatch(/data-evidence="human-ac-unproven"/);
    expect(app).not.toMatch(/unproven-ui-ac-host/);
    // Hosts are non-interactive — real mark-ready only in TaskDetail on click.
    expect(app).toMatch(
      /human-ac-l2-hosts[\s\S]*?data-evidence="human-ac-action"[\s\S]*?disabled/,
    );
  });

  it('TaskCard surfaces unproven UI AC from DecisionCard (list + under Settings)', async () => {
    const panel = await readFile(join(ROOT, 'src/web/TasksPanel.tsx'), 'utf8');
    expect(panel).toMatch(/unprovenUiFromTaskBody/);
    expect(panel).toMatch(/data-evidence="human-ac-unproven"/);
    expect(panel).toMatch(/human-ac-unproven-card/);
  });
});
