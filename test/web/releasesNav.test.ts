/**
 * Regression: Releases panel wiring — bottom-nav tab, evidence hooks,
 * confirm-guarded promote/rollback, API client paths (no token in URLs).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('Releases panel wiring', () => {
  it('bottom-nav opens Releases sheet with data-evidence=nav-releases', async () => {
    const src = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    const navMatch = /<nav className="bottom-nav"[\s\S]*?<\/nav>/.exec(src);
    expect(navMatch, 'bottom-nav landmark present').toBeTruthy();
    const nav = navMatch![0];
    expect(nav).toMatch(/data-evidence=["']nav-releases["']/);
    expect(nav).toMatch(/setReleasesOpen\(true\)/);
    expect(src).toMatch(/ReleasesPanel/);
    expect(src).toMatch(/data-sheet=["']releases["']/);
    // Unmount when closed (same as Settings/Repos/Sessions) — do not leave a
    // flex backdrop painted over the home shell via hidden={...}.
    expect(src).toMatch(/\{releasesOpen && \(/);
    expect(src).not.toMatch(/hidden=\{!releasesOpen\}/);
  });

  it('ReleasesPanel exposes panel + promote/rollback evidence hooks', async () => {
    const panel = await readFile(join(ROOT, 'src/web/ReleasesPanel.tsx'), 'utf8');
    expect(panel).toMatch(/data-evidence=["']releases-panel["']/);
    expect(panel).toMatch(/data-evidence=["']promote-btn["']/);
    expect(panel).toMatch(/data-evidence=["']rollback-btn["']/);
    expect(panel).toMatch(/data-evidence=["']deploy-staging-btn["']/);
    expect(panel).toMatch(/data-evidence=["']merge-btn["']/);
    expect(panel).toMatch(/data-evidence=["']merge-operation-status["']/);
    expect(panel).toMatch(/fetchMergeOperation/);
    expect(panel).toMatch(/data-evidence=["']staging-status["']/);
    expect(panel).toMatch(/data-evidence=["']release-packet["']/);
    // Confirm-guarded Promote + Rollback (not one-tap).
    expect(panel).toMatch(/ConfirmButton/);
    expect(panel).toMatch(/releasesPromoteConfirm|Confirm promote/);
    expect(panel).toMatch(/releasesRollbackConfirm|Confirm rollback/);
    // Empty-repos shell chrome (L2 boot uses repos: {}) still exposes promote-btn.
    expect(panel).toMatch(/shellPromoteChrome/);
    expect(panel).toMatch(/data-evidence=["']releases-shell-actions["']/);
  });

  it('client API uses Authorization header paths (no token query)', async () => {
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(api).toMatch(/fetchReleases/);
    expect(api).toMatch(/['"]\/api\/releases['"]/);
    expect(api).toMatch(/deploy-staging/);
    expect(api).toMatch(/\/merge/);
    expect(api).toMatch(/merge-operations/);
    expect(api).toMatch(/\/promote/);
    expect(api).toMatch(/\/rollback/);
    // Token must not be interpolated into release action URLs.
    expect(api).not.toMatch(/\/api\/releases\?token=/);
    expect(api).not.toMatch(/deploy-staging\?token=/);
  });

  it('server exposes GET /api/releases and POST deploy-staging', async () => {
    const server = await readFile(join(ROOT, 'src/server/api.ts'), 'utf8');
    expect(server).toMatch(/\/api\/releases/);
    expect(server).toMatch(/deploy-staging/);
    expect(server).toMatch(/listReleases/);
    expect(server).toMatch(/requestStagingDeployNow/);
    expect(server).toMatch(/merge-operations/);
    expect(server).toMatch(/startMergeOperation/);
  });
});

describe('Releases phone layout containment (2026-07-17 screenshot incident)', () => {
  it('merge list renders full-width labels without bullets; packet logs stay contained', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.releases-merge-list\s*\{[^}]*list-style:\s*none/s);
    expect(css).toMatch(/\.releases-check\s*\{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.releases-check span\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.releases-packet-body pre\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/\.releases-panel\s*\{[^}]*overflow-x:\s*hidden/s);
    const panel = await readFile(join(ROOT, 'src/web/ReleasesPanel.tsx'), 'utf8');
    // Production never deployed must not claim "matches production".
    expect(panel).toMatch(/releasesNoProductionYet/);
  });
});

describe('Releases panel responsiveness + task back button (phone report 2026-07-17)', () => {
  it('TaskDetail has a sticky top back button so long packets can still return', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    // Top-of-sheet back control, same onClose/closeLabel as the bottom button.
    const top = /className="sheet-back"[\s\S]{0,120}onClick=\{onClose\}/.exec(src);
    expect(top, 'sheet-back button wired to onClose').toBeTruthy();
    expect(src).toMatch(/\{closeLabel\}/);
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    const rule = /\.sheet-back\s*\{[\s\S]*?\}/.exec(css);
    expect(rule, '.sheet-back styled').toBeTruthy();
    expect(rule![0]).toMatch(/position:\s*sticky/);
  });

  it('ReleasesPanel paints instantly from the module cache and refreshes in background', async () => {
    const panel = await readFile(join(ROOT, 'src/web/ReleasesPanel.tsx'), 'utf8');
    expect(panel).toMatch(/releasesCache/);
    expect(panel).toMatch(/getCachedReleases\(\)/);
    expect(panel).toMatch(/setCachedReleases\(/);
    const cache = await readFile(join(ROOT, 'src/web/releasesCache.ts'), 'utf8');
    expect(cache).toMatch(/export function getCachedReleases/);
    expect(cache).toMatch(/export function setCachedReleases/);
  });
});

describe('staging auto-unlock handoff (2026-07-17)', () => {
  it('panel mints a one-time code and puts ONLY the code in the link fragment', async () => {
    const panel = await readFile(join(ROOT, 'src/web/ReleasesPanel.tsx'), 'utf8');
    expect(panel).toMatch(/mintStagingHandoff/);
    expect(panel).toMatch(/#hsc=\$\{handoffCode\}/);
    // The staging UI token must never be part of any URL.
    expect(panel).not.toMatch(/[?#&](token|hercules_token)=/);
    expect(panel).not.toMatch(/stagingUiToken\s*\}?`?[^)]{0,40}href/);
  });

  it('TokenGate redeems the #hsc fragment and strips it from history', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/handoffCodeFromHash/);
    expect(app).toMatch(/redeemStagingHandoff/);
    expect(app).toMatch(/history\.replaceState/);
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    // Redeem call is pre-auth: plain fetch without Bearer headers.
    const redeemFn = /export async function redeemStagingHandoff[\s\S]*?\n\}/.exec(api);
    expect(redeemFn, 'redeem helper present').toBeTruthy();
    expect(redeemFn![0]).not.toMatch(/authHeaders/);
  });
});

describe('self-promote restart handling (2026-07-18)', () => {
  it('promote catches the daemon-restart network error and confirms via polling', async () => {
    // Promoting Hercules itself restarts the daemon mid-response; the fetch
    // dies with a network error while the deploy continues. The panel must
    // poll for the recorded production sha instead of surfacing
    // "Network error" for a promote that actually succeeded.
    const panel = await readFile(join(ROOT, 'src/web/ReleasesPanel.tsx'), 'utf8');
    expect(panel).toMatch(/waitForPromoteOutcome/);
    expect(panel).toMatch(/isNetworkLayerFailure/);
    expect(panel).toMatch(/promoteReconcile/);
    expect(panel).toMatch(/releasesPromoteRestarting/);
    const reconcile = await readFile(join(ROOT, 'src/web/promoteReconcile.ts'), 'utf8');
    expect(reconcile).toMatch(/readPromoteTerminal/);
    expect(reconcile).toMatch(/rolled_back/);
    expect(reconcile).toMatch(/status === 0/);
  });
});
