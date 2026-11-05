/**
 * Headless Chromium audit of the live phone SPA.
 * Usage: node scripts/ux-browser-audit.mjs
 * Reads HERCULES_TOKEN from ~/.hercules/hercules.env
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findChromium } from '../dist/src/verification/browser.js';
import { launchHeadlessChrome, openCdpSession } from '../dist/src/verification/cdp.js';

const base = process.env.HERCULES_URL || 'http://127.0.0.1:8787';
const outDir = process.env.UX_AUDIT_DIR || '/tmp/hercules-ux-audit';

async function loadToken() {
  if (process.env.HERCULES_TOKEN) return process.env.HERCULES_TOKEN.trim();
  const raw = await readFile(join(homedir(), '.hercules/hercules.env'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('HERCULES_TOKEN='));
  if (!line) throw new Error('HERCULES_TOKEN not found');
  return line.slice('HERCULES_TOKEN='.length).trim();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const token = await loadToken();
  await mkdir(outDir, { recursive: true });
  const chromium = findChromium();
  if (!chromium) throw new Error('Chromium not found');
  const chrome = await launchHeadlessChrome(chromium);
  const targets = await chrome.listTargets();
  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target');
  const cdp = await openCdpSession(page.webSocketDebuggerUrl);

  async function evalJson(expression) {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }

  async function shot(name) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = join(outDir, `${name}.png`);
    await writeFile(p, Buffer.from(data, 'base64'));
    console.log('shot', p);
    return p;
  }

  const report = { base, at: new Date().toISOString(), findings: [] };

  try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp.send('Page.navigate', { url: `${base}/` });
  await wait(1000);

  // Seed auth the same way the SPA does (localStorage key).
  await evalJson(`(() => {
    localStorage.setItem('hercules_token', ${JSON.stringify(token)});
    location.reload();
    return true;
  })()`);
  await wait(1800);
  await shot('01-home');

  report.home = await evalJson(`(() => {
    const rect = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    const unlockForm = !!document.querySelector('input[type="password"], .unlock, [data-evidence="unlock"]');
    return {
      hasNav: !!document.querySelector('.bottom-nav'),
      voice: rect(document.querySelector('.voice-dock')),
      fab: rect(document.querySelector('.fab')),
      title: document.title,
      unlockVisible: unlockForm && !document.querySelector('.bottom-nav'),
      snippet: document.body.innerText.slice(0, 180),
    };
  })()`);
  if (report.home.unlockVisible) report.findings.push('HOME: still on unlock screen');

  const clickNav = async (evidence) =>
    evalJson(`(() => {
      const el = document.querySelector('[data-evidence="${evidence}"]');
      if (!el) return null;
      el.click();
      return el.textContent?.trim() ?? evidence;
    })()`);

  // Settings
  await clickNav('nav-settings');
  await wait(900);
  await shot('02-settings');
  report.settings = await evalJson(`(() => {
    const sheet = document.querySelector('.sheet');
    const head = document.querySelector('.sheet-head-row');
    const h2 = document.querySelector('.settings-panel h2');
    const grip = document.querySelector('.sheet .sheet-grip');
    const top = head || h2;
    return {
      sheetClass: sheet?.className ?? null,
      padTop: sheet ? getComputedStyle(sheet).paddingTop : null,
      gap: top && sheet ? +(top.getBoundingClientRect().top - sheet.getBoundingClientRect().top).toFixed(1) : null,
      gripVisible: !!(grip && getComputedStyle(grip).display !== 'none' && grip.getBoundingClientRect().height > 0),
      flush: sheet?.classList.contains('sheet-flush') ?? false,
    };
  })()`);
  // AC1: flush top chrome — title within a small inset of the sheet edge.
  const MAX_TOP_GAP_PX = 20;
  if (report.settings.gap != null && report.settings.gap > MAX_TOP_GAP_PX) {
    report.findings.push(`SETTINGS: top gap ${report.settings.gap}px too large`);
  }
  if (report.settings.gripVisible) report.findings.push('SETTINGS: grip still visible');
  if (!report.settings.flush) report.findings.push('SETTINGS: missing sheet-flush class');

  await evalJson(`(() => { document.querySelector('.sheet-backdrop')?.click(); return 1; })()`);
  await wait(400);

  // Repos
  await clickNav('nav-repos');
  await wait(900);
  await shot('03-repos');
  report.repos = await evalJson(`(() => {
    const sheet = document.querySelector('.sheet');
    const head = document.querySelector('.repos-panel-header, .repos-panel h2');
    const grip = document.querySelector('.sheet .sheet-grip');
    return {
      sheetClass: sheet?.className ?? null,
      padTop: sheet ? getComputedStyle(sheet).paddingTop : null,
      gap: head && sheet ? +(head.getBoundingClientRect().top - sheet.getBoundingClientRect().top).toFixed(1) : null,
      gripVisible: !!(grip && getComputedStyle(grip).display !== 'none' && grip.getBoundingClientRect().height > 0),
      flush: sheet?.classList.contains('sheet-flush') ?? false,
    };
  })()`);
  if (report.repos.gap != null && report.repos.gap > MAX_TOP_GAP_PX) {
    report.findings.push(`REPOS: top gap ${report.repos.gap}px too large`);
  }
  if (report.repos.gripVisible) report.findings.push('REPOS: grip still visible');
  if (!report.repos.flush) report.findings.push('REPOS: missing sheet-flush class');
  await evalJson(`(() => { document.querySelector('.sheet-backdrop')?.click(); return 1; })()`);
  await wait(400);

  // Chat list
  await clickNav('nav-chat');
  await wait(1000);
  await shot('04-chat-list');
  report.chatList = await evalJson(`(() => {
    const sheet = document.querySelector('.sheet');
    const head = document.querySelector('.sessions-list-head, .sessions-list-panel h2, .sheet h2');
    const grip = document.querySelector('.sheet-grip');
    const longBlurb = /Free agent chats on a repo worktree/i.test(
      document.querySelector('.sheet')?.innerText ?? '',
    );
    return {
      gap: head && sheet ? +(head.getBoundingClientRect().top - sheet.getBoundingClientRect().top).toFixed(1) : null,
      gripH: grip ? +grip.getBoundingClientRect().height.toFixed(1) : 0,
      gripVisible: !!(grip && getComputedStyle(grip).display !== 'none' && grip.getBoundingClientRect().height > 0),
      longBlurb,
      cards: document.querySelectorAll('.session-card').length,
      listPanel: !!document.querySelector('.sessions-list-panel'),
      snippet: document.querySelector('.sheet')?.innerText?.slice(0, 220) ?? '',
    };
  })()`);
  if (report.chatList.gap != null && report.chatList.gap > MAX_TOP_GAP_PX) {
    report.findings.push(`CHAT_LIST: top gap ${report.chatList.gap}px too large`);
  }
  if (report.chatList.longBlurb) report.findings.push('CHAT_LIST: long hero blurb still present');
  if (report.chatList.gripVisible) report.findings.push('CHAT_LIST: grip still visible');

  const opened = await evalJson(`(() => {
    const b = document.querySelector('.session-card-main');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await wait(1400);
  await shot('05-chat-open');
  report.chatOpen = await evalJson(`(() => {
    const sheet = document.querySelector('.sheet');
    const chrome = document.querySelector('.session-chat-chrome');
    const scroll = document.querySelector('.session-chat-scroll');
    const compose = document.querySelector('.chat-compose');
    if (!chrome || !sheet) {
      return { ok: false, snippet: document.querySelector('.sheet')?.innerText?.slice(0, 200) ?? '' };
    }
    const nearBottom = scroll
      ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
      : null;
    return {
      ok: true,
      chromeTopGap: +(chrome.getBoundingClientRect().top - sheet.getBoundingClientRect().top).toFixed(1),
      chromeH: +chrome.getBoundingClientRect().height.toFixed(1),
      scrollH: scroll ? +scroll.getBoundingClientRect().height.toFixed(1) : null,
      scrollTop: scroll?.scrollTop ?? null,
      nearBottom: nearBottom != null ? +nearBottom.toFixed(1) : null,
      scrollHeight: scroll?.scrollHeight ?? null,
      clientHeight: scroll?.clientHeight ?? null,
      composeVisible: !!(compose && compose.getBoundingClientRect().height > 0),
      footerBar: !!document.querySelector('.session-footer-bar'),
      modeChip: document.querySelector('.session-mode-chip')?.textContent?.trim() ?? null,
      moreIcon: !!document.querySelector('.session-more-icon'),
      bubbles: document.querySelectorAll('.chat-bubble').length,
      liveOpen: document.querySelector('details.activity-collapse')?.open ?? null,
      vhShareScroll: scroll
        ? +((scroll.getBoundingClientRect().height / window.innerHeight) * 100).toFixed(1)
        : null,
    };
  })()`);
  report.openedSession = opened;
  if (report.chatOpen.ok) {
    // AC1/AC2 open chat: flush chrome, no permanent footer, pinned to latest, majority height.
    if (report.chatOpen.chromeTopGap > 4) {
      report.findings.push(`CHAT: chrome top gap ${report.chatOpen.chromeTopGap}px`);
    }
    if (report.chatOpen.footerBar) report.findings.push('CHAT: footer bar still present');
    if (
      report.chatOpen.scrollHeight > (report.chatOpen.clientHeight ?? 0) + 40 &&
      (report.chatOpen.nearBottom ?? 0) > 80
    ) {
      report.findings.push(
        `CHAT: not scrolled to bottom (nearBottom=${report.chatOpen.nearBottom})`,
      );
    }
    // Majority of viewport for transcript (acceptance: not crushed by chrome).
    if ((report.chatOpen.vhShareScroll ?? 0) < 50) {
      report.findings.push(
        `CHAT: transcript only ${report.chatOpen.vhShareScroll}% of viewport height (need ≥50%)`,
      );
    }
    if ((report.chatOpen.chromeH ?? 0) > 120) {
      report.findings.push(`CHAT: chrome too tall (${report.chatOpen.chromeH}px) — expandables not collapsed`);
    }
  } else if (opened) {
    report.findings.push('CHAT: session click did not open SessionChat');
  } else {
    report.findings.push('CHAT: no session card to open (need ≥1 active session for full audit)');
  }

  report.voice = await evalJson(`(() => {
    const dock = document.querySelector('.voice-dock');
    const nav = document.querySelector('.bottom-nav');
    if (!dock || !nav) return { dock: !!dock, nav: !!nav };
    const d = dock.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    return {
      overlapsNav: d.bottom > n.top + 1 && d.top < n.bottom,
      dockBottom: +d.bottom.toFixed(1),
      navTop: +n.top.toFixed(1),
      zDock: getComputedStyle(dock).zIndex,
      zNav: getComputedStyle(nav).zIndex,
      collapsed: dock.classList.contains('is-collapsed'),
    };
  })()`);
  // AC3: voice dock not covered, above nav in z-order, collapsible by default idle.
  if (report.voice.overlapsNav) report.findings.push('VOICE: dock overlaps bottom nav');
  if (report.voice.zDock && report.voice.zNav && +report.voice.zDock <= +report.voice.zNav) {
    report.findings.push(`VOICE: z-index dock(${report.voice.zDock}) <= nav(${report.voice.zNav})`);
  }
  if (report.voice.collapsed === false) {
    report.findings.push('VOICE: idle dock should start collapsed (mini-dot)');
  }
  if (
    typeof report.voice.dockBottom === 'number' &&
    typeof report.voice.navTop === 'number' &&
    report.voice.dockBottom > report.voice.navTop + 1
  ) {
    report.findings.push('VOICE: dock bottom extends into bottom-nav band');
  }

  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('FINDINGS', report.findings.length ? report.findings : ['none']);
  process.exitCode = report.findings.length ? 2 : 0;
  } finally {
    try {
      await cdp.close?.();
    } catch {
      /* ignore */
    }
    await chrome.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
