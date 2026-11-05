/**
 * Phone SPA smoke (real Chromium + CDP): unlock with token, assert deploy
 * version stamp, open a review task sheet. Runs only when Chromium is installed
 * and dist/web has been built (`pnpm build` / check:full).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../../src/server/serve.js';
import { createApi } from '../../src/server/api.js';
import { SelfUpdateService } from '../../src/server/selfUpdate.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort, RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { findChromium } from '../../src/verification/browser.js';
import { cdpScreenshot, launchHeadlessChrome, openCdpSession } from '../../src/verification/cdp.js';
import { resolveBuildInfo, resetBuildInfoCache } from '../../src/buildInfo.js';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
const webDir = join(root, 'dist', 'web');
const hasBrowser = findChromium() !== null;
const hasWeb = existsSync(join(webDir, 'index.html'));
const TOKEN = 'spa-smoke-token';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'smoke-1',
    title: 'SPA smoke review task',
    repo: 'app',
    state: 'review',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: `## Task\n\nSmoke.\n\n## Acceptance criteria\n- [ ] (human) looks good\n\n## Review packet\n\n### smoke-1 — \`hercules/smoke-1\`\n**✅ automated proof complete**\n\n**Definition of Done**\n| Axis | Status |\n|---|---|\n| mechanical (L1) | ✅ pass |\n`,
    ...over,
  };
}

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'https://github.com/example/app.git',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null, readiness: 'ready',
    },
  },
};

class FakePort implements ControlPort {
  constructor(readonly tasks: Map<string, Task>) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

class FakeProbe implements RepoProbe {
  async probe(): Promise<{ branches: string[] }> {
    return { branches: ['main'] };
  }
}

describe.skipIf(!hasBrowser || !hasWeb)('SPA smoke (Chromium + built dist/web)', () => {
  let server: RunningServer;
  let baseUrl: string;

  beforeAll(async () => {
    resetBuildInfoCache();
    const t = task();
    const control = new FakePort(new Map([[t.id, t]]));
    const view: RuntimeView = {
      snapshot: { repos, tasks: [t], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    // Mock self-update so Settings Deploy chrome is present (never touches git/systemd).
    const selfUpdate = new SelfUpdateService({
      repoRoot: root,
      enabled: true,
      runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } },
      restarter: { async restart() {} },
    });
    // port 0 → OS ephemeral; avoid clashes with a live daemon or parallel runs.
    server = startServer({
      port: 0,
      webDir,
      token: TOKEN,
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
      },
      actions: new ActionService(control, new FakeProbe()),
      selfUpdate,
    });
    baseUrl = `http://127.0.0.1:${server.port}/`;
    // Wait for listen
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(baseUrl);
        if (res.ok || res.status === 401) break;
      } catch {
        /* retry */
      }
      await sleep(100);
    }
  }, 30_000);

  afterAll(() => {
    server?.close();
  });

  it('API exposes build stamp and SPA bakes matching version shape', async () => {
    const res = await fetch(new URL('/api/state', baseUrl), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const state = (await res.json()) as { build: { version: string } };
    expect(state.build.version).toMatch(/^v\d{8}\.\d{1,3}$/);
    // Built JS should contain the same short sha (or date stamp)
    const index = await readFile(join(webDir, 'index.html'), 'utf8');
    const jsMatch = /src="(\/assets\/[^"]+\.js)"/.exec(index);
    expect(jsMatch).toBeTruthy();
    const js = await readFile(join(webDir, jsMatch![1]!.slice(1)), 'utf8');
    // SPA version is baked at build time — must look like vYYYYMMDD.*
    expect(js).toMatch(/v\d{8}\.\d{1,3}/);
  });

  it('SPA shell is no-cache; hashed assets may be long-cached', async () => {
    const shell = await fetch(baseUrl);
    expect(shell.status).toBe(200);
    const shellCc = shell.headers.get('cache-control') ?? '';
    expect(shellCc).toMatch(/no-cache|no-store/i);

    const index = await readFile(join(webDir, 'index.html'), 'utf8');
    const jsMatch = /src="(\/assets\/[^"]+\.js)"/.exec(index);
    expect(jsMatch).toBeTruthy();
    const asset = await fetch(new URL(jsMatch![1]!, baseUrl));
    expect(asset.status).toBe(200);
    const assetCc = asset.headers.get('cache-control') ?? '';
    expect(assetCc).toMatch(/max-age=\d+/i);
  });

  it('unlocks SPA, shows version pill, opens review sheet', async () => {
    const bin = findChromium()!;
    const chrome = await launchHeadlessChrome(bin);
    try {
      const targets = await chrome.listTargets();
      const page = targets.find((t) => t.type === 'page') ?? targets[0];
      if (!page?.webSocketDebuggerUrl) throw new Error('no page');
      const s = await openCdpSession(page.webSocketDebuggerUrl);
      try {
        await s.send('Page.enable');
        await s.send('Runtime.enable');
        await s.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await s.send('Page.navigate', { url: baseUrl });
        await sleep(1200);
        await s.send('Runtime.evaluate', {
          expression: `localStorage.setItem('hercules_token', ${JSON.stringify(TOKEN)}); location.reload();`,
        });
        await sleep(2500);
        const ver = await s.send('Runtime.evaluate', {
          expression: `document.querySelector('.topbar-version')?.textContent ?? ''`,
          returnByValue: true,
        });
        const versionText = String((ver['result'] as { value?: string } | undefined)?.value ?? '');
        // Chip: `M/D · #N` (date + day push count), or ↻ / copied feedback.
        expect(versionText.length).toBeGreaterThanOrEqual(4);
        expect(versionText).toMatch(/#\d+|copied|↻/i);

        const body = await s.send('Runtime.evaluate', {
          expression: `document.body.innerText`,
          returnByValue: true,
        });
        const text = String((body['result'] as { value?: string } | undefined)?.value ?? '');
        expect(text).toMatch(/Needs review|SPA smoke|smoke-1/i);

        // Open the review card
        await s.send('Runtime.evaluate', {
          expression: `(() => {
            const cards = [...document.querySelectorAll('button.card')];
            const t = cards.find(c => /smoke/i.test(c.innerText)) || cards[0];
            if (t) t.click();
            return t ? t.innerText.slice(0, 80) : 'none';
          })()`,
          returnByValue: true,
        });
        await sleep(800);
        const sheet = await s.send('Runtime.evaluate', {
          expression: `document.querySelector('.sheet')?.innerText?.slice(0, 500) ?? ''`,
          returnByValue: true,
        });
        const sheetText = String((sheet['result'] as { value?: string } | undefined)?.value ?? '');
        expect(sheetText.length).toBeGreaterThan(20);
        expect(sheetText).toMatch(/Human acceptance|Review|smoke|Definition of Done|Task/i);

        // Capture evidence PNG (assert non-empty)
        const shot = await s.send('Page.captureScreenshot', { format: 'png' });
        const data = shot['data'];
        expect(typeof data).toBe('string');
        expect(String(data).length).toBeGreaterThan(1000);

        // Task-list pull-to-refresh hooks (task-5 L2 evidence) on the tasks page.
        // `list` is a host-daemon compat alias (main still classifies bare「列表」
        // as list and asserts data-evidence=list until that classifier ships).
        const ptrProbe = await s.send('Runtime.evaluate', {
          expression: `(() => {
            const need = ['task-list', 'list', 'pull-to-refresh', 'pull-indicator'];
            return need.map((h) => ({
              h,
              ok: !!document.querySelector('[data-evidence="' + h + '"]'),
            }));
          })()`,
          returnByValue: true,
        });
        const ptrHooks = (ptrProbe['result'] as { value?: { h: string; ok: boolean }[] } | undefined)
          ?.value;
        expect(Array.isArray(ptrHooks)).toBe(true);
        for (const row of ptrHooks ?? []) {
          expect(row.ok, `missing data-evidence=${row.h}`).toBe(true);
        }

        // Critical Settings path (WORKFLOW L2): open nav-settings → panel hooks.
        await s.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector('[data-evidence=nav-settings]');
            if (el) el.click();
            return el ? 'ok' : 'missing';
          })()`,
          returnByValue: true,
        });
        await sleep(900);
        const settingsProbe = await s.send('Runtime.evaluate', {
          expression: `(() => {
            const need = ['settings-panel', 'settings-language', 'settings-agent', 'settings-logout', 'settings-update', 'settings-update-btn'];
            return need.map((h) => ({
              h,
              ok: !!document.querySelector('[data-evidence="' + h + '"]'),
            }));
          })()`,
          returnByValue: true,
        });
        const hooks = (settingsProbe['result'] as { value?: { h: string; ok: boolean }[] } | undefined)
          ?.value;
        expect(Array.isArray(hooks)).toBe(true);
        for (const row of hooks ?? []) {
          expect(row.ok, `missing data-evidence=${row.h}`).toBe(true);
        }

        // Releases panel (release-6): nav → panel shell + empty state.
        await s.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector('[data-evidence=nav-releases]');
            if (el) el.click();
            return el ? 'ok' : 'missing';
          })()`,
          returnByValue: true,
        });
        await sleep(900);
        const releasesProbe = await s.send('Runtime.evaluate', {
          expression: `(() => {
            const need = ['nav-releases', 'releases-panel', 'promote-btn'];
            return need.map((h) => ({
              h,
              ok: !!document.querySelector('[data-evidence="' + h + '"]'),
            }));
          })()`,
          returnByValue: true,
        });
        const relHooks = (
          releasesProbe['result'] as { value?: { h: string; ok: boolean }[] } | undefined
        )?.value;
        expect(Array.isArray(relHooks)).toBe(true);
        for (const row of relHooks ?? []) {
          expect(row.ok, `missing data-evidence=${row.h}`).toBe(true);
        }

        // Closed: Releases sheet unmounts (like Settings) — no panel over Tasks.
        await s.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector('[data-evidence=nav-tasks]');
            if (el) el.click();
            return el ? 'ok' : 'missing';
          })()`,
          returnByValue: true,
        });
        await sleep(400);
        const closed = await s.send('Runtime.evaluate', {
          expression: `(() => ({
            panel: !!document.querySelector('[data-evidence=releases-panel]'),
            promote: !!document.querySelector('[data-evidence=promote-btn]'),
          }))()`,
          returnByValue: true,
        });
        const closedHooks = (closed['result'] as {
          value?: { panel?: boolean; promote?: boolean };
        } | undefined)?.value;
        expect(closedHooks?.panel, 'releases-panel unmounted when Tasks active').toBe(false);
        expect(closedHooks?.promote, 'promote-btn not on task list when closed').toBe(false);
      } finally {
        s.close();
      }
    } finally {
      await chrome.close();
    }
  }, 60_000);

  it('cdpScreenshot helper can unlock and return PNG bytes', async () => {
    const bin = findChromium()!;
    const raw = await cdpScreenshot({
      bin,
      url: baseUrl,
      width: 390,
      height: 844,
      localStorage: { hercules_token: TOKEN },
    });
    const buf = Array.isArray(raw) ? raw[0]! : raw;
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(buf.length).toBeGreaterThan(500);
  }, 60_000);
});

// Silence unused when skipped — resolveBuildInfo used indirectly via server view
void resolveBuildInfo;
void createApi;
