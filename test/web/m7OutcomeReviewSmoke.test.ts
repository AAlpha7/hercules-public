/**
 * M7 real-browser proof: built SPA + authenticated API + isolated fake-only
 * provider. This suite deliberately lives in the post-build SPA smoke gate.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildM7ReviewFixtureEnvelope } from '../../scripts/l2-review-fixture-data.mjs';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { Task } from '../../src/domain/task.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort, RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { openIsolatedM7ReviewApiDeps } from '../../src/server/api.js';
import { startServer, type RunningServer } from '../../src/server/serve.js';
import { findChromium } from '../../src/verification/browser.js';
import {
  launchHeadlessChrome,
  openCdpSession,
  type CdpSession,
} from '../../src/verification/cdp.js';
import type { ReviewPackageV2Dto } from '../../src/web/review/reviewTypes.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const webDir = join(root, 'dist', 'web');
const hasBrowser = findChromium() !== null;
const hasWeb = existsSync(join(webDir, 'index.html'));
const TOKEN = 'm7-outcome-review-smoke-token';
const execFile = promisify(execFileCallback);

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

const repos: ReposConfig = {
  repos: {
    fixture: {
      key: 'fixture',
      url: 'https://github.com/example/m7-fixture.git',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null,
      readiness: 'ready',
    },
  },
};

/** Six labelled shots + 决策摘要 chip lines for the media viewport scene. */
function mediaRichBody(taskId: string): string {
  const shots = ['shot-a', 'shot-b', 'shot-c', 'shot-d', 'shot-e', 'shot-f'];
  const markers = shots
    .map((name, i) => {
      const mark = i === 5 ? '❌' : '✅';
      return (
        `- ${mark} screenshot ${name}\n` +
        `![evidence](/api/tasks/${taskId}/screenshots/${name}.png)`
      );
    })
    .join('\n');
  return `## Task

Isolated M7 outcome review fixture with strip media.

## Review packet

### ${taskId} — \`hercules/${taskId}\`
**✅ automated proof complete** (human Approve still required if human ACs exist)

## 决策摘要

- **改动**:${taskId}(6 个文件改动)
- **可信度**:门禁 6/6 绿 · 独立审稿:通过 · 浏览器行为证据 6 步通过 · CLI行为证据 1 步通过
- **风险**:无标记风险

**Behavioral evidence** *(declarative plan — not label guessing)*

${markers}
`;
}

/** Legacy operator-first scene: one human↔video + one unverified criterion. */
function operatorNeedsYouBody(taskId: string): string {
  const card = {
    v: 1,
    purpose: 'Operator-first smoke',
    areas: [{ area: 'src/web', count: 1 }],
    filesTouched: 2,
    reviewOnlyFlags: [
      { kind: 'test-edit', meaningZh: '改动了测试文件，需确认测试仍在真正约束行为' },
    ],
    criteria: [
      {
        text: '看录像确认滚动',
        kind: 'human',
        status: 'pending',
        why: 'CLI 步骤 scroll ✓ · 0 张截图 · 1 段录像',
      },
      {
        text: 'unit coverage',
        kind: 'mechanical',
        status: 'unverified',
        why: '无法自动核验',
      },
    ],
    gates: [
      { name: 'typecheck', passed: true },
      { name: 'test', passed: true },
    ],
    evidence: { ran: true, ok: true, steps: 1 },
    boundaries: {
      branch: `hercules/${taskId}`,
      protectedPathsTouched: false,
      testsEdited: true,
      crossTaskIds: [],
      crossTaskCommits: [],
    },
    reviewer: { ran: true, approved: true },
    unverifiedCriteria: [
      {
        text: 'unit coverage',
        warning: '无法自动核验：输出未含文件名',
      },
    ],
  };
  return `## Goal
Operator-first review smoke.

## Definition of Done
- [ ] (human) 看录像确认滚动
- [ ] (mechanical) unit coverage

## Review packet

### ${taskId} — \`hercules/${taskId}\`
**✅ automated proof complete** (1 项无法自动核验，需人工确认 · human Approve still required if human ACs exist)

## 决策摘要

- **改动**:${taskId}(2 个文件改动)
- **可信度**:门禁 2/2 绿 · 独立审稿:通过 · 浏览器行为证据 1 步通过
- **风险**:测试有改动

**Behavioral evidence**

- ✅ \`scroll\` — recorded
![evidence](/api/tasks/${taskId}/screenshots/demo.webm)

<!-- hercules:decision-card
${JSON.stringify(card)}
-->
`;
}

function task(id: string, title: string): Task {
  const body =
    id === 'l2-m7-pass-media'
      ? mediaRichBody(id)
      : id === 'l2-m7-operator'
        ? operatorNeedsYouBody(id)
        : '## Task\n\nIsolated M7 outcome review fixture.\n';
  return {
    id,
    title,
    repo: 'fixture',
    state: 'review',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 1,
    lastEventAt: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    startedAt: '2026-08-29T00:00:00.000Z',
    endedAt: '2026-08-29T00:00:06.000Z',
    prUrl: null,
    prStatus: null,
    planPending: false,
    body,
  };
}

class FakePort implements ControlPort {
  constructor(readonly tasks: Map<string, Task>) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(value: Task): Promise<void> { this.tasks.set(value.id, value); }
  async deleteTask(id: string): Promise<void> { this.tasks.delete(id); }
  async commit(): Promise<{ committed: boolean }> { return { committed: true }; }
  async writeRepos(): Promise<void> {}
}

class FakeProbe implements RepoProbe {
  async probe(): Promise<{ branches: string[] }> { return { branches: ['main'] }; }
}

function resultValue<T>(result: Record<string, unknown>): T | undefined {
  return (result['result'] as { value?: T } | undefined)?.value;
}

async function evaluate<T>(session: CdpSession, expression: string): Promise<T> {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return resultValue<T>(result) as T;
}

async function waitFor<T>(
  session: CdpSession,
  expression: string,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T;
  do {
    latest = await evaluate<T>(session, expression);
    if (accept(latest)) return latest;
    await sleep(100);
  } while (Date.now() < deadline);
  const pageText = await evaluate<string>(session, 'document.body?.innerText?.slice(0, 1200) ?? ""');
  throw new Error(
    `timed out waiting for ${label}: ${JSON.stringify(latest)}; page=${JSON.stringify(pageText)}`,
  );
}

async function click(session: CdpSession, selector: string): Promise<void> {
  const clicked = await evaluate<boolean>(session, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  expect(clicked, `clickable ${selector}`).toBe(true);
}

async function openTask(session: CdpSession, taskId: string): Promise<void> {
  await click(session, `[data-task-id=${taskId}]`);
  await waitFor<boolean>(
    session,
    `!!document.querySelector('[data-evidence=review-mode-outcome]')`,
    Boolean,
    `${taskId} review mode`,
  );
  await click(session, '[data-evidence=review-mode-outcome]');
  await waitFor<boolean>(
    session,
    `!!document.querySelector('[data-evidence=outcome-review]')`,
    Boolean,
    `${taskId} outcome review`,
  );
}

async function closeTask(session: CdpSession): Promise<void> {
  await click(session, '[data-evidence=task-detail-close]');
  await waitFor<boolean>(
    session,
    `!document.querySelector('[data-evidence=task-detail-close]')`,
    Boolean,
    'task detail close',
  );
}

interface ScreenshotReceipt {
  readonly scene: string;
  readonly viewport: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface FileReceipt {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

async function filesUnder(directory: string, prefix = ''): Promise<FileReceipt[]> {
  const receipts: FileReceipt[] = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      receipts.push(...await filesUnder(directory, relative));
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(join(directory, relative));
    receipts.push({
      path: relative,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.byteLength,
    });
  }
  return receipts;
}

async function exactCandidateBinding(): Promise<Readonly<{
  commit: string;
  tree: string;
  buildFiles: readonly FileReceipt[];
}>> {
  const [{ stdout: commit }, { stdout: tree }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: root }),
    execFile('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }),
    execFile('git', ['status', '--porcelain=v1'], { cwd: root }),
  ]);
  if (status.trim().length > 0) {
    throw new Error('retained M7 browser evidence requires a clean exact candidate');
  }
  return {
    commit: commit.trim(),
    tree: tree.trim(),
    buildFiles: await filesUnder(webDir),
  };
}

describe('M7 outcome review real browser proof', () => {
  let server: RunningServer;
  let baseUrl: string;
  let scratch: string;
  let workRoot: string;
  let runtime: RuntimeView;
  let actions: ActionService;
  let screenshotRoot: string;
  let preserveScreenshots = false;
  const receipts: ScreenshotReceipt[] = [];

  const bootReviewServer = async (): Promise<void> => {
    const reviewDeps = await openIsolatedM7ReviewApiDeps({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_L2_ISOLATED: '1',
        HERCULES_M7_L2_FIXTURE_PATH: join(workRoot, 'm7-review-fixture.json'),
      },
      workRoot,
    });
    expect(reviewDeps.reviewPackageV2).toBeDefined();
    expect(reviewDeps.reviewDecisions).toBe(reviewDeps.reviewPackageV2);
    server = startServer({
      port: await freeLoopbackPort(),
      hostname: '127.0.0.1',
      webDir,
      token: TOKEN,
      runtime: {
        getState: () => runtime,
        subscribe: () => () => {},
        forceAbort: () => {},
      },
      actions,
      workRoot,
      screenshotsRoot: screenshotRoot,
      ...reviewDeps,
    });
    baseUrl = `http://127.0.0.1:${server.port}/`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) return;
      } catch {
        // Retry until the ephemeral listener is ready.
      }
      await sleep(100);
    }
    throw new Error('M7 browser proof server did not become ready');
  };

  beforeAll(async () => {
    expect(hasBrowser, 'M7 browser proof requires Chromium').toBe(true);
    expect(hasWeb, 'M7 browser proof requires a built SPA').toBe(true);
    scratch = await mkdtemp(join(tmpdir(), 'hercules-m7-browser-'));
    workRoot = join(scratch, 'work');
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const requestedRoot = process.env['HERCULES_M7_L2_SCREENSHOTS_DIR']?.trim();
    preserveScreenshots = requestedRoot !== undefined && requestedRoot.length > 0;
    screenshotRoot = requestedRoot && requestedRoot.length > 0
      ? requestedRoot
      : join(scratch, 'screenshots');
    await mkdir(screenshotRoot, { recursive: true, mode: 0o700 });
    // Seed real PNG bytes for the media-rich scene (API serves from screenshotsRoot).
    const mediaTaskDir = join(screenshotRoot, 'l2-m7-pass-media');
    await mkdir(mediaTaskDir, { recursive: true, mode: 0o700 });
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    for (const name of ['shot-a', 'shot-b', 'shot-c', 'shot-d', 'shot-e', 'shot-f']) {
      await writeFile(join(mediaTaskDir, `${name}.png`), tinyPng, { mode: 0o600 });
    }
    const fixture = buildM7ReviewFixtureEnvelope();
    const fixturePath = join(workRoot, 'm7-review-fixture.json');
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    const tasks = new Map(
      fixture.payload.tasks.map((entry) => [
        entry.source.task.id,
        task(entry.source.task.id, entry.source.task.title),
      ]),
    );
    tasks.set(
      'l2-m7-operator',
      task('l2-m7-operator', '[L2 fixture] Operator-first needs-you'),
    );
    const operatorShotDir = join(screenshotRoot, 'l2-m7-operator');
    await mkdir(operatorShotDir, { recursive: true, mode: 0o700 });
    await writeFile(join(operatorShotDir, 'demo.webm'), Buffer.from('webm'), {
      mode: 0o600,
    });
    const control = new FakePort(tasks);
    runtime = {
      snapshot: { repos, tasks: [...tasks.values()], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    actions = new ActionService(control, new FakeProbe());
    await bootReviewServer();
  }, 30_000);

  afterAll(async () => {
    server?.close();
    if (preserveScreenshots) {
      const candidate = await exactCandidateBinding();
      await writeFile(
        join(screenshotRoot, 'manifest.json'),
        `${JSON.stringify({
          schema: 'hercules-m7-browser-proof/v2',
          candidate,
          receipts,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  });

  it('executes all decision-bearing scenes at mobile and desktop viewports', async () => {
    const chrome = await launchHeadlessChrome(findChromium()!);
    try {
      const targets = await chrome.listTargets();
      const page = targets.find((target) => target.type === 'page') ?? targets[0];
      if (!page?.webSocketDebuggerUrl) throw new Error('no CDP page target');
      const session = await openCdpSession(page.webSocketDebuggerUrl);
      try {
        await session.send('Page.enable');
        await session.send('Runtime.enable');

        const capture = async (scene: string, viewport: string): Promise<void> => {
          const result = await session.send('Page.captureScreenshot', { format: 'png' });
          const bytes = Buffer.from(String(result['data'] ?? ''), 'base64');
          expect(bytes.subarray(0, 8)).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          );
          expect(bytes.byteLength).toBeGreaterThan(1_000);
          const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          receipts.push({ scene, viewport, sha256, byteLength: bytes.byteLength });
          await writeFile(join(screenshotRoot, `${viewport}-${scene}.png`), bytes, { mode: 0o600 });
        };

        const visualActions: Record<'mobile' | 'desktop', Record<string, readonly string[]>> = {
          mobile: {},
          desktop: {},
        };

        const assertLayout = async (viewport: 'mobile' | 'desktop'): Promise<void> => {
          const layout = await evaluate<{
            bodyText: number;
            viewportWidth: number;
            viewportHeight: number;
            documentWidth: number;
            sheetLeft: number;
            sheetRight: number;
            sheetBottom: number;
            navTop: number;
            navBottom: number;
            outcomeRight: number;
            outcomeWidth: number;
            sheetWidth: number;
            sheetScrollWidth: number;
            sheetClientWidth: number;
            outcomeScrollWidth: number;
            outcomeClientWidth: number;
            navPaddingBottom: number;
            drawerBottom: number | null;
            drawerPosition: string | null;
            drawerPaddingBottom: number | null;
            drawerScrollWidth: number | null;
            drawerClientWidth: number | null;
            controlsContained: boolean;
            controlsOverlap: boolean;
            externalObstructions: readonly string[];
          }>(session, `(() => {
            const sheet = document.querySelector('.sheet');
            const nav = document.querySelector('.bottom-nav');
            const outcome = document.querySelector('[data-evidence=outcome-review]');
            if (!(sheet instanceof HTMLElement) || !(nav instanceof HTMLElement) ||
                !(outcome instanceof HTMLElement)) return null;
            const sr = sheet.getBoundingClientRect();
            const nr = nav.getBoundingClientRect();
            const or = outcome.getBoundingClientRect();
            const drawer = document.querySelector('[data-evidence=review-evidence-drawer]');
            const dr = drawer instanceof HTMLElement ? drawer.getBoundingClientRect() : null;
            const controls = [...outcome.querySelectorAll('button, textarea, input')]
              .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0)
              .map((node) => node.getBoundingClientRect())
              .filter((rect) => rect.bottom > sr.top && rect.top < sr.bottom);
            const externalObstructions = ['.fab', '.voice-shell'].filter((selector) => {
              const node = document.querySelector(selector);
              if (!(node instanceof HTMLElement)) return false;
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' ||
                  Number.parseFloat(style.opacity) === 0) return false;
              const rect = node.getBoundingClientRect();
              return Math.min(rect.right, sr.right) - Math.max(rect.left, sr.left) > 1 &&
                Math.min(rect.bottom, sr.bottom) - Math.max(rect.top, sr.top) > 1;
            });
            return {
              bodyText: document.body.innerText.trim().length,
              viewportWidth: document.documentElement.clientWidth,
              viewportHeight: window.innerHeight,
              documentWidth: document.documentElement.scrollWidth,
              sheetLeft: sr.left,
              sheetRight: sr.right,
              sheetBottom: sr.bottom,
              navTop: nr.top,
              navBottom: nr.bottom,
              outcomeRight: or.right,
              outcomeWidth: or.width,
              sheetWidth: sr.width,
              sheetScrollWidth: sheet.scrollWidth,
              sheetClientWidth: sheet.clientWidth,
              outcomeScrollWidth: outcome.scrollWidth,
              outcomeClientWidth: outcome.clientWidth,
              navPaddingBottom: parseFloat(getComputedStyle(nav).paddingBottom),
              drawerBottom: dr?.bottom ?? null,
              drawerPosition: drawer instanceof HTMLElement ? getComputedStyle(drawer).position : null,
              drawerPaddingBottom: drawer instanceof HTMLElement
                ? parseFloat(getComputedStyle(drawer).paddingBottom)
                : null,
              drawerScrollWidth: drawer instanceof HTMLElement ? drawer.scrollWidth : null,
              drawerClientWidth: drawer instanceof HTMLElement ? drawer.clientWidth : null,
              controlsContained: controls.every((rect) =>
                rect.left >= sr.left - 1 && rect.right <= sr.right + 1 &&
                Math.min(rect.bottom, sr.bottom) <= nr.top + 1),
              controlsOverlap: controls.some((left, index) => controls.slice(index + 1).some((right) =>
                Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
                Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1)),
              externalObstructions,
            };
          })()`);
          expect(layout, `${viewport} layout exists`).not.toBeNull();
          expect(layout.bodyText, `${viewport} nonblank content`).toBeGreaterThan(100);
          expect(layout.documentWidth, `${viewport} horizontal overflow`).toBeLessThanOrEqual(
            layout.viewportWidth,
          );
          expect(layout.sheetLeft).toBeGreaterThanOrEqual(-1);
          expect(layout.sheetRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
          expect(layout.sheetBottom, `${viewport} sheet clears bottom nav`).toBeLessThanOrEqual(
            layout.navTop + 1,
          );
          expect(layout.navBottom, `${viewport} bottom nav stays in safe viewport`).toBeLessThanOrEqual(
            layout.viewportHeight + 1,
          );
          expect(layout.outcomeRight).toBeLessThanOrEqual(layout.sheetRight + 1);
          expect(layout.outcomeWidth).toBeLessThanOrEqual(layout.sheetWidth + 1);
          expect(layout.sheetScrollWidth).toBeLessThanOrEqual(layout.sheetClientWidth);
          expect(layout.outcomeScrollWidth).toBeLessThanOrEqual(layout.outcomeClientWidth);
          expect(layout.controlsContained, `${viewport} controls do not overlap navigation`).toBe(true);
          expect(layout.controlsOverlap, `${viewport} controls do not overlap each other`).toBe(false);
          expect(layout.externalObstructions, `${viewport} global chrome does not cover the sheet`).toEqual([]);
          expect(layout.navPaddingBottom).toBeGreaterThanOrEqual(viewport === 'mobile' ? 41 : 7);
          if (layout.drawerBottom !== null) {
            if (layout.drawerPosition === 'fixed') {
            expect(layout.drawerBottom, `${viewport} evidence drawer clears navigation`).toBeLessThanOrEqual(
              layout.navTop + 1,
            );
            }
            expect(layout.drawerScrollWidth).toBeLessThanOrEqual(layout.drawerClientWidth!);
            if (viewport === 'mobile') expect(layout.drawerPaddingBottom).toBeGreaterThanOrEqual(47);
          }
        };

        const bodyText = (): Promise<string> => evaluate<string>(session, 'document.body.innerText');
        const outcomeText = (): Promise<string> => evaluate<string>(
          session,
          `document.querySelector('[data-evidence=outcome-review]')?.innerText ?? ''`,
        );
        const selectorExists = (selector: string): Promise<boolean> =>
          evaluate<boolean>(session, `!!document.querySelector(${JSON.stringify(selector)})`);
        const fetchPackage = async (taskId: string): Promise<ReviewPackageV2Dto> => {
          const response = await fetch(
            new URL(`/api/v2/tasks/${encodeURIComponent(taskId)}/review-package`, baseUrl),
            { headers: { authorization: `Bearer ${TOKEN}` } },
          );
          expect(response.status).toBe(200);
          return response.json() as Promise<ReviewPackageV2Dto>;
        };
        const axisStatus = (label: string): Promise<string> => evaluate<string>(session, `(() => {
          const rows = [...document.querySelectorAll('.outcome-review-axis')];
          const row = rows.find((candidate) => candidate.firstElementChild?.textContent === ${JSON.stringify(label)});
          return row?.querySelector('.outcome-review-status')?.textContent ?? '';
        })()`);
        const currentActions = (): Promise<readonly string[]> => evaluate<string[]>(session, `[
          ['approve_outcome', '[data-evidence=review-open-approve]'],
          ['reject_outcome', '[data-evidence=review-open-reject]'],
          ['request_changes', '[data-evidence=review-request-changes]'],
        ].filter(([, selector]) => !!document.querySelector(selector)).map(([action]) => action)`);
        const assertNoLegacyTaskActions = async (): Promise<void> => {
          expect(await selectorExists('[data-evidence=legacy-task-actions]')).toBe(false);
          expect(await selectorExists('.sheet button[data-evidence=task-open-pr]')).toBe(false);
        };
        const assertFirstViewport = async (actionSelector: string): Promise<void> => {
          const positions = await evaluate<Array<{ selector: string; top: number; bottom: number }>>(
            session,
            `(() => {
              const selectors = [
                '.outcome-review-header',
                '.outcome-review-axis-grid',
                '[aria-label="Outcome review summary"]',
                '[data-evidence=review-decision-status]',
                ${JSON.stringify(actionSelector)},
              ];
              return selectors.map((selector) => {
                const rect = document.querySelector(selector)?.getBoundingClientRect();
                return { selector, top: rect?.top ?? Number.POSITIVE_INFINITY, bottom: rect?.bottom ?? Number.POSITIVE_INFINITY };
              });
            })()`,
          );
          const navTop = await evaluate<number>(
            session,
            `document.querySelector('.bottom-nav')?.getBoundingClientRect().top ?? 0`,
          );
          const hits = await evaluate<Array<{ selector: string; tag: string | null; covered: boolean }>>(
            session,
            `(() => {
              const selectors = [
                '.outcome-review-header',
                '.outcome-review-axis-grid',
                '[aria-label="Outcome review summary"]',
                '[data-evidence=review-decision-status]',
                ${JSON.stringify(actionSelector)},
              ];
              return selectors.map((selector) => {
                const el = document.querySelector(selector);
                if (!(el instanceof HTMLElement)) return { selector, tag: null, covered: true };
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const top = document.elementFromPoint(cx, cy);
                const covered = !(top instanceof Element) || !(top === el || el.contains(top));
                return { selector, tag: top?.nodeName ?? null, covered };
              });
            })()`,
          );
          process.stdout.write(
            `M7 first-viewport ${actionSelector}: top=${String(positions.at(-1)?.top)} bottom=${String(positions.at(-1)?.bottom)} navTop=${String(navTop)} hits=${JSON.stringify(hits.map((h) => [h.selector, h.tag, h.covered]))}\n`,
          );
          for (const position of positions) {
            expect(
              position.bottom,
              `${position.selector} is fully visible before scrolling: ${JSON.stringify(positions)} navTop=${String(navTop)}`,
            ).toBeLessThanOrEqual(navTop + 1);
          }
          for (const hit of hits) {
            expect(
              hit.covered,
              `${hit.selector} centre must hit the element or a descendant (got ${String(hit.tag)})`,
            ).toBe(false);
          }
        };

        /** C3.32 — legacy operator verdict + primary action in first viewport. */
        const assertOperatorVerdictFirstViewport = async (): Promise<{
          readonly headline: string;
          readonly needsKinds: readonly string[];
          readonly geometry: {
            readonly verdictBottom: number;
            readonly actionBottom: number;
            readonly navTop: number;
            readonly flagsAboveAction: boolean;
          };
        }> => {
          await click(session, '[data-evidence=review-mode-legacy]');
          await waitFor<boolean>(
            session,
            `!!document.querySelector('[data-evidence=review-verdict]') &&
             !!document.querySelector('[data-evidence=review-primary-action]')`,
            Boolean,
            'legacy operator verdict',
          );
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          const geometry = await evaluate<{
            verdictBottom: number;
            actionBottom: number;
            navTop: number;
            flagsAboveAction: boolean;
            actionTop: number;
            hits: Array<{ selector: string; tag: string | null; covered: boolean }>;
          }>(session, `(() => {
            const selectors = [
              '[data-evidence=review-verdict]',
              '[data-evidence=review-primary-action]',
            ];
            const nav = document.querySelector('.bottom-nav');
            const navTop = nav?.getBoundingClientRect().top ?? 0;
            const action = document.querySelector('[data-evidence=review-primary-action]');
            const actionTop = action?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
            const flags = [...document.querySelectorAll('[data-evidence=review-only-flags], .ds-criterion, .ds-boundaries')];
            const flagsAboveAction = flags.some((node) => {
              if (!(node instanceof HTMLElement)) return false;
              const rect = node.getBoundingClientRect();
              return rect.bottom > 0 && rect.top < actionTop && rect.height > 0;
            });
            const hits = selectors.map((selector) => {
              const el = document.querySelector(selector);
              if (!(el instanceof HTMLElement)) return { selector, tag: null, covered: true };
              const rect = el.getBoundingClientRect();
              const cx = rect.left + Math.min(rect.width / 2, 24);
              const cy = rect.top + Math.min(rect.height / 2, 24);
              const top = document.elementFromPoint(cx, cy);
              const covered = !(top instanceof Element) || !(top === el || el.contains(top));
              return { selector, tag: top?.nodeName ?? null, covered };
            });
            return {
              verdictBottom: document.querySelector('[data-evidence=review-verdict]')?.getBoundingClientRect().bottom ?? Infinity,
              actionBottom: action?.getBoundingClientRect().bottom ?? Infinity,
              actionTop,
              navTop,
              flagsAboveAction,
              hits,
            };
          })()`);
          process.stdout.write(
            `M7 operator-verdict geom: verdictBottom=${String(geometry.verdictBottom)} actionBottom=${String(geometry.actionBottom)} navTop=${String(geometry.navTop)} flagsAbove=${String(geometry.flagsAboveAction)} hits=${JSON.stringify(geometry.hits)}\n`,
          );
          expect(geometry.verdictBottom).toBeLessThanOrEqual(geometry.navTop + 1);
          expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.navTop + 1);
          expect(geometry.flagsAboveAction, 'gate/flag rows must not sit above primary action').toBe(false);
          for (const hit of geometry.hits) {
            expect(hit.covered, `${hit.selector} centre hit`).toBe(false);
          }
          const snapshot = await evaluate<{
            headline: string;
            needsKinds: string[];
          }>(session, `(() => {
            const headline = document.querySelector('.review-verdict-headline')?.textContent?.trim() ?? '';
            const needsKinds = [...document.querySelectorAll('[data-evidence=review-needs-you] [data-needs-kind]')]
              .map((node) => node.getAttribute('data-needs-kind') ?? '');
            return { headline, needsKinds };
          })()`);
          await click(session, '[data-evidence=review-mode-outcome]');
          await waitFor<boolean>(
            session,
            `!!document.querySelector('[data-evidence=outcome-review]')`,
            Boolean,
            'restore outcome mode',
          );
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          return {
            headline: snapshot.headline,
            needsKinds: snapshot.needsKinds,
            geometry: {
              verdictBottom: geometry.verdictBottom,
              actionBottom: geometry.actionBottom,
              navTop: geometry.navTop,
              flagsAboveAction: geometry.flagsAboveAction,
            },
          };
        };

        const runVisualScenes = async (viewport: 'mobile' | 'desktop'): Promise<void> => {
          const desktop = viewport === 'desktop';
          await session.send('Emulation.setDeviceMetricsOverride', {
            width: desktop ? 1440 : 390,
            height: desktop ? 1000 : 844,
            deviceScaleFactor: 1,
            mobile: !desktop,
          });
          await session.send('Emulation.setSafeAreaInsetsOverride', {
            insets: desktop
              ? { top: 0, left: 0, bottom: 0, right: 0 }
              : { top: 47, left: 0, bottom: 34, right: 0 },
          });
          await session.send('Page.navigate', { url: baseUrl });
          await sleep(700);
          await evaluate<void>(session, `(() => {
            localStorage.setItem('hercules_token', ${JSON.stringify(TOKEN)});
            localStorage.setItem('hercules_review_experience', 'outcome_v2');
            location.reload();
          })()`);
          await waitFor<boolean>(
            session,
            `!!document.querySelector('[data-task-id=l2-m7-pass]')`,
            Boolean,
            `${viewport} task list`,
          );

          await openTask(session, 'l2-m7-pass');
          await assertNoLegacyTaskActions();
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          await assertOperatorVerdictFirstViewport();
          visualActions[viewport]['pass'] = await currentActions();
          await assertFirstViewport('[data-evidence=review-request-changes]');
          const independent = await evaluate<string>(session, `(() => {
            const rows = [...document.querySelectorAll('.outcome-review-axis')];
            return rows.find((row) => /Independent review/i.test(row.textContent ?? ''))?.textContent ?? '';
          })()`);
          expect(independent).toMatch(/Independent review/i);
          expect(independent).toMatch(/Not applicable/i);
          await click(session, '[data-evidence=open-review-evidence]');
          await waitFor<boolean>(
            session,
            `!!document.querySelector('[data-evidence=review-evidence-drawer]') &&
             !!document.querySelector('[data-evidence=learning-proposal]') &&
             !!document.querySelector('[data-evidence=review-evidence-drawer] pre')`,
            Boolean,
            `${viewport} evidence and learning`,
          );
          expect(await outcomeText()).toMatch(/passed[\s\S]*true/i);
          await assertLayout(viewport);
          await capture('pass-evidence-learning', viewport);
          await closeTask(session);

          await openTask(session, 'l2-m7-fail');
          await assertNoLegacyTaskActions();
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          await assertOperatorVerdictFirstViewport();
          visualActions[viewport]['fail'] = await currentActions();
          await assertFirstViewport('[data-evidence=review-request-changes]');
          const failText = await outcomeText();
          expect(failText).toMatch(/Verified failure/i);
          expect(await selectorExists('[data-evidence=review-request-changes]')).toBe(true);
          expect(await selectorExists('[data-evidence=review-open-approve]')).toBe(false);
          expect(await axisStatus('Evaluation')).toMatch(/Failed/i);
          expect(await axisStatus('Independent review')).toMatch(/Not applicable/i);
          await assertLayout(viewport);
          await capture('verified-evaluator-fail', viewport);
          await closeTask(session);

          await openTask(session, 'l2-m7-missing');
          await assertNoLegacyTaskActions();
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          await assertOperatorVerdictFirstViewport();
          visualActions[viewport]['missing'] = await currentActions();
          await assertFirstViewport('[data-evidence=review-more-evidence]');
          const missingText = await outcomeText();
          expect(missingText).toMatch(/More evidence required/i);
          expect(missingText).not.toMatch(/Verified failure/i);
          expect(await selectorExists('[data-evidence=review-request-changes]')).toBe(false);
          expect(await selectorExists('[data-evidence=review-more-evidence]')).toBe(true);
          expect(await axisStatus('Evaluation')).toMatch(/Needs evidence/i);
          expect(await axisStatus('Independent review')).toMatch(/Not applicable/i);
          await assertLayout(viewport);
          await capture('missing-evidence', viewport);
          await closeTask(session);

          await openTask(session, 'l2-m7-human');
          await assertNoLegacyTaskActions();
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          await assertOperatorVerdictFirstViewport();
          visualActions[viewport]['human'] = await currentActions();
          await assertFirstViewport('[data-evidence=review-open-approve]');
          await click(session, '[data-evidence=review-open-approve]');
          await waitFor<boolean>(
            session,
            `!!document.querySelector('[data-evidence=review-risk-acknowledgement]')`,
            Boolean,
            `${viewport} human confirmation`,
          );
          expect(await bodyText()).toMatch(/Approval is not merge or deployment/i);
          await assertLayout(viewport);
          await capture('human-confirmation', viewport);
          await closeTask(session);

          // Media-heavy strip: six shots + five credibility chips must keep
          // the decision action fully above the bottom nav (B5).
          await openTask(session, 'l2-m7-pass-media');
          await assertNoLegacyTaskActions();
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          await assertOperatorVerdictFirstViewport();
          visualActions[viewport]['pass-media'] = await currentActions();
          const mediaGeom = await evaluate<{
            stripHeight: number;
            requestTop: number;
            requestBottom: number;
            approveTop: number;
            approveBottom: number;
            navTop: number;
            shotCount: number;
            chipCount: number;
          }>(session, `(() => {
            const strip = document.querySelector('[data-evidence=evidence-first]');
            const req = document.querySelector('[data-evidence=review-request-changes]');
            const appr = document.querySelector('[data-evidence=review-open-approve]');
            const nav = document.querySelector('.bottom-nav');
            return {
              stripHeight: strip?.getBoundingClientRect().height ?? -1,
              requestTop: req?.getBoundingClientRect().top ?? -1,
              requestBottom: req?.getBoundingClientRect().bottom ?? -1,
              approveTop: appr?.getBoundingClientRect().top ?? -1,
              approveBottom: appr?.getBoundingClientRect().bottom ?? -1,
              navTop: nav?.getBoundingClientRect().top ?? -1,
              shotCount: document.querySelectorAll('[data-evidence=evidence-shot]').length,
              chipCount: document.querySelectorAll('[data-evidence=evidence-chip]').length,
            };
          })()`);
          process.stdout.write(
            `M7 media-geom ${viewport}: stripH=${String(mediaGeom.stripHeight)} ` +
              `request=${String(mediaGeom.requestTop)}..${String(mediaGeom.requestBottom)} ` +
              `approve=${String(mediaGeom.approveTop)}..${String(mediaGeom.approveBottom)} ` +
              `navTop=${String(mediaGeom.navTop)} shots=${String(mediaGeom.shotCount)} chips=${String(mediaGeom.chipCount)}\n`,
          );
          expect(mediaGeom.shotCount, `${viewport} media strip shots`).toBe(6);
          expect(mediaGeom.chipCount, `${viewport} credibility chips`).toBeGreaterThanOrEqual(5);
          // Scroll the evidence strip so lazy tiles (if any) intersect, then
          // wait until every tile's <img> has decoded (naturalWidth > 0).
          await evaluate<void>(session, `(() => {
            const strip = document.querySelector('[data-evidence=evidence-first]');
            if (strip instanceof HTMLElement) {
              strip.scrollLeft = strip.scrollWidth;
              strip.scrollLeft = 0;
            }
          })()`);
          const loadedTiles = await waitFor<{ count: number; widths: number[] }>(
            session,
            `(() => {
              const shots = [...document.querySelectorAll('[data-evidence=evidence-shot]')];
              const widths = shots.map((shot) => {
                const img = shot.querySelector('img');
                return img instanceof HTMLImageElement ? img.naturalWidth : 0;
              });
              return { count: shots.length, widths };
            })()`,
            (value) =>
              value.count === 6 && value.widths.length === 6 && value.widths.every((w) => w > 0),
            `${viewport} loaded evidence tiles`,
            12_000,
          );
          process.stdout.write(
            `M7 loaded-tiles ${viewport}: count=${String(loadedTiles.count)} widths=${JSON.stringify(loadedTiles.widths)}\n`,
          );
          expect(loadedTiles.widths.every((w) => w > 0)).toBe(true);
          await assertFirstViewport('[data-evidence=review-request-changes]');
          if (mediaGeom.approveTop >= 0) {
            await assertFirstViewport('[data-evidence=review-open-approve]');
          }
          await assertLayout(viewport);
          await capture('pass-media', viewport);
          await closeTask(session);

          // C3.32 operator-first: human↔video + unverified needs-you (legacy surface).
          await click(session, `[data-task-id=l2-m7-operator]`);
          await waitFor<boolean>(
            session,
            `!!document.querySelector('[data-evidence=review-mode-legacy]')`,
            Boolean,
            `${viewport} operator review mode`,
          );
          await click(session, '[data-evidence=review-mode-legacy]');
          await waitFor<boolean>(
            session,
            `!!document.querySelector('[data-evidence=review-verdict]')`,
            Boolean,
            `${viewport} operator verdict`,
          );
          await evaluate<void>(session, `document.querySelector('.sheet')?.scrollTo(0, 0)`);
          const operatorSnap = await evaluate<{
            headline: string;
            needsKinds: string[];
            needsCount: number;
            verdictBottom: number;
            actionBottom: number;
            navTop: number;
            flagsAboveAction: boolean;
          }>(session, `(() => {
            const headline = document.querySelector('.review-verdict-headline')?.textContent?.trim() ?? '';
            const needs = [...document.querySelectorAll('[data-evidence=review-needs-you] [data-needs-kind]')];
            const action = document.querySelector('[data-evidence=review-primary-action]');
            const actionTop = action?.getBoundingClientRect().top ?? Infinity;
            const flags = [...document.querySelectorAll('[data-evidence=review-only-flags], .ds-criterion')];
            const flagsAboveAction = flags.some((node) => {
              if (!(node instanceof HTMLElement)) return false;
              const r = node.getBoundingClientRect();
              return r.height > 0 && r.top < actionTop && r.bottom > 0;
            });
            return {
              headline,
              needsKinds: needs.map((n) => n.getAttribute('data-needs-kind') ?? ''),
              needsCount: needs.length,
              verdictBottom: document.querySelector('[data-evidence=review-verdict]')?.getBoundingClientRect().bottom ?? Infinity,
              actionBottom: action?.getBoundingClientRect().bottom ?? Infinity,
              navTop: document.querySelector('.bottom-nav')?.getBoundingClientRect().top ?? 0,
              flagsAboveAction,
            };
          })()`);
          process.stdout.write(
            `M7 operator-scene ${viewport}: headline=${JSON.stringify(operatorSnap.headline)} kinds=${JSON.stringify(operatorSnap.needsKinds)} ` +
              `verdictBottom=${String(operatorSnap.verdictBottom)} actionBottom=${String(operatorSnap.actionBottom)} navTop=${String(operatorSnap.navTop)}\n`,
          );
          expect(operatorSnap.needsCount).toBe(2);
          expect(operatorSnap.needsKinds).toEqual(['human', 'unverified']);
          expect(operatorSnap.headline).toMatch(/机器检查全部通过/);
          expect(operatorSnap.headline).toMatch(/看录像后批准/);
          expect(operatorSnap.headline).toMatch(/无法自动核验/);
          expect(operatorSnap.verdictBottom).toBeLessThanOrEqual(operatorSnap.navTop + 1);
          expect(operatorSnap.actionBottom).toBeLessThanOrEqual(operatorSnap.navTop + 1);
          expect(operatorSnap.flagsAboveAction).toBe(false);
          visualActions[viewport]['operator-needs-you'] = ['legacy_operator_verdict'];
          await capture('operator-needs-you', viewport);
          await closeTask(session);
        };

        await runVisualScenes('mobile');
        await runVisualScenes('desktop');
        expect(visualActions.desktop).toEqual(visualActions.mobile);

        // Return to a phone viewport for the mutation paths.
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await session.send('Emulation.setSafeAreaInsetsOverride', {
          insets: { top: 47, left: 0, bottom: 34, right: 0 },
        });
        await session.send('Page.navigate', { url: baseUrl });
        await waitFor<boolean>(
          session,
          `!!document.querySelector('[data-task-id=l2-m7-fail]')`,
          Boolean,
          'mobile mutation task list',
        );

        // A real UI POST creates one successor and keeps the prior iteration row.
        await openTask(session, 'l2-m7-fail');
        const initialFailPackage = await fetchPackage('l2-m7-fail');
        const filled = await evaluate<boolean>(session, `(() => {
          const textarea = document.querySelector('#review-request-changes-reason');
          if (!(textarea instanceof HTMLTextAreaElement)) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(textarea, 'Repair the verified failing criterion.');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        expect(filled).toBe(true);
        await click(session, '[data-evidence=review-request-changes]');
        let failPackage = await fetchPackage('l2-m7-fail');
        const mutationDeadline = Date.now() + 12_000;
        while (failPackage.iterations.length !== 2 && Date.now() < mutationDeadline) {
          await sleep(100);
          failPackage = await fetchPackage('l2-m7-fail');
        }
        expect(failPackage.iterations).toHaveLength(2);
        const prior = failPackage.iterations.find((iteration) => iteration.ordinal === 1)!;
        const successor = failPackage.iterations.find((iteration) => iteration.ordinal === 2)!;
        const initialPrior = initialFailPackage.iterations[0]!;
        expect(prior).toMatchObject({
          id: initialPrior.id,
          ordinal: 1,
          state: 'failed',
          candidateRef: initialPrior.candidateRef,
          evidenceManifestId: initialPrior.evidenceManifestId,
          finalVerdictId: initialPrior.finalVerdictId,
          createdAt: initialPrior.createdAt,
        });
        expect(prior.endedAt).not.toBeNull();
        expect(successor).toMatchObject({
          ordinal: 2,
          state: 'planned',
          candidateRef: null,
          evidenceManifestId: null,
          finalVerdictId: null,
          createdAt: prior.endedAt,
          endedAt: null,
        });
        expect(failPackage.binding.contractVersion).toBe(initialFailPackage.binding.contractVersion);
        await waitFor<boolean>(
          session,
          `!!document.querySelector('[data-iteration-id=${successor.id}]') &&
           !!document.querySelector('[data-iteration-id=${prior.id}]')`,
          Boolean,
          'request changes successor history',
          12_000,
        );
        await evaluate<void>(session, `document.querySelector('[data-evidence=review-iteration-history]')?.scrollIntoView()`);
        await capture('request-changes-successor-history', 'mobile');
        await closeTask(session);

        // Reopen the provider and HTTP server from the same scratch root. The
        // browser must still see the exact durable successor and prior row.
        server.close();
        await sleep(150);
        await bootReviewServer();
        await session.send('Page.navigate', { url: baseUrl });
        await sleep(500);
        await evaluate<void>(session, `(() => {
          localStorage.setItem('hercules_token', ${JSON.stringify(TOKEN)});
          localStorage.setItem('hercules_review_experience', 'outcome_v2');
          location.reload();
        })()`);
        await waitFor<boolean>(
          session,
          `!!document.querySelector('[data-task-id=l2-m7-fail]')`,
          Boolean,
          'task list after provider restart',
        );
        await openTask(session, 'l2-m7-fail');
        await waitFor<boolean>(
          session,
          `!!document.querySelector('[data-iteration-id=${successor.id}]') &&
           !!document.querySelector('[data-iteration-id=${prior.id}]')`,
          Boolean,
          'durable successor history after restart',
        );
        await evaluate<void>(session, `document.querySelector('[data-evidence=review-iteration-history]')?.scrollIntoView()`);
        await capture('durable-successor-after-restart', 'mobile');
        await closeTask(session);

        // Hold an old projection in the browser, mutate it through a concurrent
        // exact-bound request, then prove the browser POST receives 409 and
        // surfaces the stale explanation before authoritative refetch.
        await openTask(session, 'l2-m7-pass');
        const passPackage = await fetchPackage('l2-m7-pass');
        expect(passPackage.decisionBinding).not.toBeNull();
        await evaluate<void>(session, `(() => {
          const original = window.fetch.bind(window);
          window.__m7DecisionStatuses = [];
          window.__m7ObservedText = [];
          window.__m7StaleSeen = false;
          window.__m7RefetchGate = new Promise((resolve) => {
            window.__m7ReleaseRefetch = resolve;
          });
          const observer = new MutationObserver(() => {
            const text = document.body.innerText;
            if (/review changed before this decision was accepted/i.test(text)) {
              window.__m7ObservedText.push(text);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          window.fetch = async (...args) => {
            const url = String(args[0] instanceof Request ? args[0].url : args[0]);
            if (window.__m7StaleSeen && /review-package/.test(url)) {
              await window.__m7RefetchGate;
            }
            const response = await original(...args);
            if (/review-decisions/.test(url)) {
              window.__m7DecisionStatuses.push(response.status);
              if (response.status === 409) window.__m7StaleSeen = true;
            }
            return response;
          };
        })()`);
        const concurrentRequest = {
          schema: 'hercules-review-decision-request/v1',
          clientRequestId: `review-${randomUUID()}`,
          taskId: passPackage.task.id,
          projectionHash: passPackage.projectionHash,
          decisionBinding: passPackage.decisionBinding,
          action: 'request_changes',
          reason: 'Concurrent exact-bound update.',
          acknowledgedRiskCodes: [],
        };
        const concurrent = await fetch(
          new URL('/api/v2/tasks/l2-m7-pass/review-decisions', baseUrl),
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(concurrentRequest),
          },
        );
        expect(concurrent.status).toBe(200);
        const staleFilled = await evaluate<boolean>(session, `(() => {
          const textarea = document.querySelector('#review-request-changes-reason');
          if (!(textarea instanceof HTMLTextAreaElement)) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(textarea, 'This stale tab must be rejected.');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        expect(staleFilled).toBe(true);
        await click(session, '[data-evidence=review-request-changes]');
        await waitFor<boolean>(
          session,
          `window.__m7DecisionStatuses?.includes(409) === true &&
           window.__m7ObservedText?.length > 0`,
          Boolean,
          'stale 409 and explanation',
          12_000,
        );
        expect(await bodyText()).toMatch(/review changed before this decision was accepted/i);
        await capture('stale-rejected-explained', 'mobile');
        await evaluate<void>(session, 'window.__m7ReleaseRefetch?.()');
      } finally {
        session.close();
      }
    } finally {
      await chrome.close();
    }
  }, 120_000);
});

declare global {
  interface Window {
    __m7DecisionStatuses?: number[];
    __m7ObservedText?: string[];
    __m7StaleSeen?: boolean;
    __m7RefetchGate?: Promise<void>;
    __m7ReleaseRefetch?: () => void;
  }
}
