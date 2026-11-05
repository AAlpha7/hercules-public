/**
 * Real Chromium measure: assistant reply bubble height vs content / 75% cap.
 * Usage: node scripts/measure-assistant-height.mjs
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findChromium } from '../dist/src/verification/browser.js';
import { launchHeadlessChrome, openCdpSession } from '../dist/src/verification/cdp.js';

const base = process.env.HERCULES_URL || 'http://127.0.0.1:8787';
const outDir = process.env.OUT || '/tmp/grok-assistant-height';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(outDir, { recursive: true });
  const env = await readFile(join(homedir(), '.hercules/hercules.env'), 'utf8');
  const token = env
    .split('\n')
    .find((l) => l.startsWith('HERCULES_TOKEN='))
    ?.slice('HERCULES_TOKEN='.length)
    ?.trim();
  if (!token) throw new Error('no HERCULES_TOKEN');

  const chrome = await launchHeadlessChrome(findChromium());
  try {
    const targets = await chrome.listTargets();
    const page = targets.find((t) => t.type === 'page') ?? targets[0];
    const cdp = await openCdpSession(page.webSocketDebuggerUrl);

    async function evalJson(expression) {
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    }
    async function shot(name) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    }

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
    await evalJson(`(() => {
      localStorage.setItem('hercules_token', ${JSON.stringify(token)});
      localStorage.setItem('hercules_assistant_mode', 'text');
      localStorage.setItem('hercules_voice_dock', JSON.stringify({
        collapsed: false, x: 0.9, y: 0.7
      }));
      location.reload();
      return 1;
    })()`);
    await wait(2000);

    // Activate orb until panel shows (pointerup path).
    for (let i = 0; i < 4; i += 1) {
      const has = await evalJson(
        `!!document.querySelector('[data-evidence="assistant-text-panel"]')`,
      );
      if (has) break;
      await evalJson(`(() => {
        const dock = document.querySelector('.voice-dock');
        const orb = document.querySelector('[data-evidence="voice-orb"]');
        const el = dock || orb;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        for (const type of ['pointerdown', 'pointerup', 'click']) {
          el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0,
          }));
        }
        orb?.click();
        return true;
      })()`);
      await wait(400);
    }

    const result = await evalJson(`(() => {
      const panel = document.querySelector('[data-evidence="assistant-text-panel"]');
      const log = document.querySelector('[data-evidence="assistant-text-log"]');
      if (!panel || !log) {
        return {
          ok: false,
          reason: 'no-panel',
          dock: !!document.querySelector('.voice-dock'),
          orb: !!document.querySelector('[data-evidence="voice-orb"]'),
          mode: document.querySelector('[data-evidence="voice-dock"]')?.getAttribute('data-mode'),
          collapsed: document.querySelector('[data-evidence="voice-orb"]')?.getAttribute('data-collapsed'),
        };
      }

      // Inject controlled short + long bubbles (layout probe).
      log.querySelectorAll('[data-probe]').forEach((n) => n.remove());
      const short = document.createElement('div');
      short.className = 'voice-text-bubble voice-text-assistant';
      short.setAttribute('data-evidence', 'assistant-reply-bubble');
      short.setAttribute('data-probe', 'short');
      short.innerHTML =
        '<div class="voice-reply-chrome"><span class="muted">短</span>' +
        '<button type="button" class="voice-reply-expand-btn">全屏</button></div>' +
        '<div class="voice-reply-scroll"><div class="voice-reply-body"><p>短回复一行。</p></div></div>';
      const long = document.createElement('div');
      long.className = 'voice-text-bubble voice-text-assistant';
      long.setAttribute('data-evidence', 'assistant-reply-bubble');
      long.setAttribute('data-probe', 'long');
      const paras = Array.from({ length: 40 }, (_, i) =>
        '<p>长内容第 ' + (i + 1) + ' 行，用于验证贴合内容与 75% 外框封顶。</p>',
      ).join('');
      long.innerHTML =
        '<div class="voice-reply-chrome"><span class="muted">长</span>' +
        '<button type="button" class="voice-reply-expand-btn">全屏</button></div>' +
        '<div class="voice-reply-scroll"><div class="voice-reply-body">' +
        paras +
        '</div></div>';
      log.appendChild(short);
      log.appendChild(long);

      // Force layout
      void long.offsetHeight;

      const panelH = panel.getBoundingClientRect().height;
      const logH = log.clientHeight;
      const logVar = getComputedStyle(log).getPropertyValue('--assistant-log-h').trim();
      // Cap is 75% of the message log's *visible* height (what CSS actually uses).
      const cap = Math.max(120, logH * 0.75);
      const measure = (el, tag) => {
        const body = el.querySelector('.voice-reply-body');
        const scroll = el.querySelector('.voice-reply-scroll');
        const br = el.getBoundingClientRect();
        const bodyH = body?.scrollHeight ?? 0;
        const scrollClient = scroll?.clientHeight ?? 0;
        const bubbleH = br.height;
        const maxH = getComputedStyle(el).maxHeight;
        return {
          tag,
          bubbleH: +bubbleH.toFixed(1),
          bodyH,
          scrollClientH: +scrollClient.toFixed(1),
          maxH,
          flex: getComputedStyle(el).flex,
          // Short: not crushed; roughly content-sized
          crushed: bodyH > 150 && bubbleH < 100,
          underCap: bubbleH <= cap + 6,
          // Long content must hit the cap (within 15%) and scroll inside
          nearCap: bodyH > cap ? bubbleH >= cap * 0.85 : true,
          shortOk: tag !== 'short' || (bubbleH >= 36 && bubbleH <= cap),
          longScrolls: tag !== 'long' || bodyH > scrollClient + 20,
          growsWithContent: tag !== 'short' || bubbleH >= bodyH,
        };
      };

      const shortM = measure(short, 'short');
      const longM = measure(long, 'long');
      const ok =
        !shortM.crushed &&
        !longM.crushed &&
        shortM.underCap &&
        longM.underCap &&
        shortM.shortOk &&
        longM.nearCap &&
        longM.longScrolls &&
        shortM.growsWithContent &&
        shortM.flex.startsWith('0 0');

      return {
        ok,
        panelH: +panelH.toFixed(1),
        logH: +logH.toFixed(1),
        logVar,
        cap75: +cap.toFixed(1),
        panelVar: getComputedStyle(panel).getPropertyValue('--assistant-panel-h').trim(),
        short: shortM,
        long: longM,
      };
    })()`);

    await writeFile(join(outDir, 'final-measure.json'), JSON.stringify(result, null, 2));
    await shot('final-height');
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error('BROWSER_HEIGHT_FAIL');
      process.exitCode = 2;
    } else {
      console.log('BROWSER_HEIGHT_OK');
    }
  } finally {
    await chrome.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
