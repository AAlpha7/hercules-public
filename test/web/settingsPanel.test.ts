/**
 * SettingsPanel structure: language segments, agent select, self-update, logout confirm.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('SettingsPanel', () => {
  it('exports SettingsPanel with lang + preferredAgent callbacks', async () => {
    const src = await readFile(join(ROOT, 'src/web/SettingsPanel.tsx'), 'utf8');
    expect(src).toMatch(/export function SettingsPanel/);
    expect(src).toMatch(/onLangChange/);
    expect(src).toMatch(/onPreferredAgentChange/);
    expect(src).toMatch(/onLogout/);
    expect(src).toMatch(/SegmentedControl/);
    expect(src).toMatch(/ConfirmButton/);
    // Must not call signOut without confirm.
    expect(src).not.toMatch(/onClick=\{onLogout\}/);
  });

  it('exposes L2 data-evidence hooks for settings chrome', async () => {
    const panel = await readFile(join(ROOT, 'src/web/SettingsPanel.tsx'), 'utf8');
    expect(panel).toMatch(/data-evidence=["']settings-panel["']/);
    expect(panel).toMatch(/data-evidence=["']settings-language["']/);
    expect(panel).toMatch(/data-evidence=["']settings-agent["']/);
    expect(panel).toMatch(/data-evidence=["']settings-cost-caps["']/);
    expect(panel).toMatch(/data-evidence=["']settings-logout["']/);
    expect(panel).toMatch(/data-evidence=["']settings-update["']/);
    expect(panel).toMatch(/data-evidence=["']settings-update-btn["']/);

    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/data-evidence=["']nav-settings["']/);
    // Bottom nav must not keep a direct logout evidence hook.
    expect(app).not.toMatch(/data-evidence=["']nav-logout["']/);
  });

  it('accepts optional costSummary prop for spend summary', async () => {
    const panel = await readFile(join(ROOT, 'src/web/SettingsPanel.tsx'), 'utf8');
    expect(panel).toMatch(/costSummary/);
    expect(panel).toMatch(/settingsCostTitle/);
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/costSummary=\{state\?\.costSummary/);
  });

  it('renders billing mode, thresholds, and cost meaning from costSummary', async () => {
    const panel = await readFile(join(ROOT, 'src/web/SettingsPanel.tsx'), 'utf8');
    expect(panel).toMatch(/data-evidence=["']settings-cost-billing-mode["']/);
    expect(panel).toMatch(/data-evidence=["']settings-cost-meaning["']/);
    expect(panel).toMatch(/data-evidence=["']settings-cost-thresholds["']/);
    expect(panel).toMatch(/data-evidence=["']settings-cost-enforced["']/);
    expect(panel).toMatch(/data-evidence=["']settings-cost-advisory["']/);
    expect(panel).toMatch(/data-evidence=["']settings-cost-billing-note["']/);
    expect(panel).toMatch(/settingsCostBillingMode/);
    expect(panel).toMatch(/settingsCostThresholds/);
    expect(panel).toMatch(/settingsCostMeaningSubscription/);
    expect(panel).toMatch(/costMeaningKey/);
    expect(panel).toMatch(/policy\.perTask/);
  });

  it('self-update requires ConfirmButton + startSelfUpdate (not a bare click)', async () => {
    const panel = await readFile(join(ROOT, 'src/web/SettingsPanel.tsx'), 'utf8');
    expect(panel).toMatch(/startSelfUpdate/);
    expect(panel).toMatch(/settingsUpdateConfirm/);
    // Must not fire update on a plain onClick without the confirm arm.
    expect(panel).not.toMatch(/onClick=\{onUpdateConfirm\}/);
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(api).toMatch(/confirm:\s*true/);
    expect(api).toMatch(/\/api\/system\/update/);
  });

  it('renders self-update log tail so phone can see pull/build progress', async () => {
    const panel = await readFile(join(ROOT, 'src/web/SettingsPanel.tsx'), 'utf8');
    // Status.log from GET/POST /api/system/update must surface in Deploy UI.
    expect(panel).toMatch(/update\.log/);
    expect(panel).toMatch(/data-evidence=["']settings-update-log["']/);
    expect(panel).toMatch(/settings-update-log/);
  });

  it('CreateForm seeds adapter from preferred agent when no explicit prefill', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    const create = await readFile(join(ROOT, 'src/web/CreateForm.tsx'), 'utf8');
    // Preferred agent from settings flows into CreateForm default.
    expect(app).toMatch(/preferredAgent|loadPreferredAgent/);
    expect(app).toMatch(/CreateForm/);
    expect(create).toMatch(/preferredAgent/);
    expect(create).toMatch(/seedAdapter|availableAgents\.includes\(preferredAgent\)/);
  });
});
