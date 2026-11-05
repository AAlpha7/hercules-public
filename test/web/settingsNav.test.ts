/**
 * Regression: bottom-nav sign-out is a Settings tab (not direct Logout).
 * Settings sheet hosts language, preferred default agent, and two-tap Logout.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('bottom nav Settings (was Logout)', () => {
  it('opens Settings sheet instead of ConfirmButton logout in the nav', async () => {
    const src = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    const navMatch = /<nav className="bottom-nav"[\s\S]*?<\/nav>/.exec(src);
    expect(navMatch, 'bottom-nav landmark present').toBeTruthy();
    const nav = navMatch![0];

    // Old one-tap Token control must not remain.
    expect(nav).not.toMatch(/<span>\s*Token\s*<\/span>/);
    expect(nav).not.toMatch(/onClick=\{signOut\}/);

    // No ConfirmButton logout in the bottom nav itself.
    expect(nav).not.toMatch(/<ConfirmButton\b/);
    expect(nav).not.toMatch(/<span>\s*Logout\s*<\/span>/);
    expect(nav).not.toMatch(/data-evidence=["']nav-logout["']/);

    // Settings tab opens the settings sheet.
    expect(nav).toMatch(/data-evidence=["']nav-settings["']/);
    expect(nav).toMatch(/setSettingsOpen\(true\)/);
    expect(nav).toMatch(/Settings|settingsOpen|t\(lang,\s*['"]navSettings['"]\)/);
    expect(nav).toMatch(/bottom-nav-icon/);
  });

  it('wires SettingsPanel with language, default agent, and logout', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/SettingsPanel/);
    expect(app).toMatch(/settingsOpen/);
    expect(app).toMatch(/signOut/);

    const panel = await readFile(join(ROOT, 'src/web/SettingsPanel.tsx'), 'utf8');
    // Language: zh / en via SegmentedControl
    expect(panel).toMatch(/SegmentedControl/);
    expect(panel).toMatch(/['"]en['"]/);
    expect(panel).toMatch(/['"]zh['"]/);
    // Default / preferred agent select
    expect(panel).toMatch(/availableAgents|preferredAgent|defaultAgent/);
    // Two-tap logout stays inside settings
    expect(panel).toMatch(/ConfirmButton/);
    expect(panel).toMatch(/onLogout|onConfirm/);
  });

  it('ConfirmButton still accepts ReactNode labels', async () => {
    const src = await readFile(join(ROOT, 'src/web/ConfirmButton.tsx'), 'utf8');
    expect(src).toMatch(/label:\s*ReactNode/);
    expect(src).toMatch(/confirmLabel:\s*ReactNode/);
  });
});
