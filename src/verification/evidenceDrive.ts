/**
 * L2 evidence interpreter — executes a declarative {@link EvidencePlan} over CDP.
 * No label heuristics: only unlock / CSS click / assert / screenshot.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EvidencePlan, EvidenceRunSummary, EvidenceStep, EvidenceStepResult } from '../domain/evidence.js';
import {
  collectL2HollowShots,
  detectHollowEvidence,
  HOLLOW_EVIDENCE_DETAIL_PREFIX,
} from '../domain/hollowEvidence.js';
import {
  throwIfVerificationAborted,
  VerificationAbortedError,
} from '../domain/verificationRun.js';
import {
  launchHeadlessChrome,
  openCdpSession,
  type CdpSession,
} from './cdp.js';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';

export interface EvidenceDriveInput {
  readonly bin: string;
  readonly url: string;
  readonly plan: EvidencePlan;
  readonly screenshotDir: string;
  readonly authToken?: string;
  readonly authStorageKey?: string;
  readonly width?: number;
  readonly height?: number;
  readonly settleMs?: number;
  /** Human cancel — close chrome mid-drive, do not wait for full plan. */
  readonly signal?: AbortSignal;
  /** Repository policy for the Chromium verification child. */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}

/** Default wait budget for assert steps (SPA data loads after boot). */
const ASSERT_WAIT_MS = 10_000;
const ASSERT_POLL_INTERVAL_MS = 400;

/**
 * Poll an async condition until true or the budget runs out. Assert steps
 * evaluated exactly once used to catch boot-time "Loading…" frames.
 */
export async function pollAssert(
  check: () => Promise<boolean>,
  opts: { readonly timeoutMs: number; readonly intervalMs: number },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(opts.intervalMs);
  }
}

export async function runEvidencePlan(input: EvidenceDriveInput): Promise<EvidenceRunSummary> {
  throwIfVerificationAborted(input.signal);
  const chrome = await launchHeadlessChrome(input.bin, {
    ...(input.executionPolicy !== undefined
      ? { executionPolicy: input.executionPolicy }
      : {}),
  });
  const results: EvidenceStepResult[] = [];
  const screenshots: string[] = [];
  let shotIndex = 0;
  let onAbort: (() => void) | null = null;

  const detachAbort = (): void => {
    if (onAbort && input.signal) {
      input.signal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
  };

  if (input.signal) {
    onAbort = (): void => {
      void chrome.close();
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    throwIfVerificationAborted(input.signal);
    const targets = await chrome.listTargets();
    const page = targets.find((t) => t.type === 'page') ?? targets[0];
    if (!page?.webSocketDebuggerUrl) {
      return failAll(input.plan, 'no CDP page target');
    }
    const s = await openCdpSession(page.webSocketDebuggerUrl);
    try {
      throwIfVerificationAborted(input.signal);
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      const w = input.width ?? 390;
      const h = input.height ?? 844;
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await s.send('Page.navigate', { url: input.url });
      await sleep(input.settleMs ?? 1200);
      throwIfVerificationAborted(input.signal);

      for (const step of input.plan.steps) {
        throwIfVerificationAborted(input.signal);
        const r = await runStep(s, step, {
          ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
          authStorageKey: input.authStorageKey ?? 'hercules_token',
          screenshotDir: input.screenshotDir,
          settleMs: input.settleMs ?? 900,
          nextShot: () => {
            const name = step.name?.trim() || `step-${shotIndex}`;
            shotIndex += 1;
            return join(input.screenshotDir, `${sanitize(name)}.png`);
          },
        });
        results.push(r);
        if (r.screenshot) screenshots.push(r.screenshot);
      }
    } finally {
      s.close();
    }
  } catch (err) {
    if (input.signal?.aborted) {
      throw err instanceof VerificationAbortedError
        ? err
        : new VerificationAbortedError('verification aborted during evidence drive');
    }
    throw err;
  } finally {
    detachAbort();
    await chrome.close();
  }

  throwIfVerificationAborted(input.signal);
  const hollow = detectHollowEvidence(
    collectL2HollowShots(
      results.map((r) => ({
        kind: r.step.kind,
        ok: r.ok,
        ...(r.screenshot !== undefined ? { screenshot: r.screenshot } : {}),
        ...(r.screenshotSha256 !== undefined
          ? { screenshotSha256: r.screenshotSha256 }
          : {}),
        ...(r.step.raw !== undefined ? { raw: r.step.raw } : {}),
      })),
    ),
  );
  let finalResults = results;
  if (hollow.hits.length > 0) {
    // Fail closed: mark every screenshot step that shares a hollow hash.
    const hollowShas = new Set(hollow.hits.map((h) => h.sha256));
    finalResults = results.map((r) => {
      if (
        r.screenshotSha256 !== undefined &&
        hollowShas.has(r.screenshotSha256) &&
        r.ok
      ) {
        return {
          ...r,
          ok: false,
          detail:
            HOLLOW_EVIDENCE_DETAIL_PREFIX +
            (hollow.detail ?? 'identical screenshots across scenarios'),
        };
      }
      return r;
    });
  }
  const ok = finalResults.every((r) => r.ok || r.step.optional === true);
  return { plan: input.plan, results: finalResults, ok, screenshots };
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'shot';
}

function failAll(plan: EvidencePlan, detail: string): EvidenceRunSummary {
  return {
    plan,
    results: plan.steps.map((step) => ({
      step,
      ok: false,
      detail,
    })),
    ok: false,
    screenshots: [],
  };
}

async function runStep(
  s: CdpSession,
  step: EvidenceStep,
  ctx: {
    authToken?: string;
    authStorageKey: string;
    screenshotDir: string;
    settleMs: number;
    nextShot: () => string;
  },
): Promise<EvidenceStepResult> {
  try {
    switch (step.kind) {
      case 'unlock': {
        if (!ctx.authToken) {
          return { step, ok: true, detail: 'no auth token configured (skipped inject)' };
        }
        const k = ctx.authStorageKey;
        const v = ctx.authToken;
        await s.send('Runtime.evaluate', {
          expression: `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)}); location.reload();`,
        });
        await sleep(Math.max(ctx.settleMs, 1500));
        return { step, ok: true, detail: 'token injected + reload' };
      }
      case 'click': {
        const sel = step.selector ?? '';
        if (!sel) return { step, ok: false, detail: 'missing selector' };
        // Click then force parent <details> open when the target is a
        // <summary> (or inside one). Native summary clicks *toggle*; L2 steps
        // mean "reveal section for assert/screenshot". Always set open=true
        // (not only when already closed) so a deferred toggle cannot race
        // past a !details.open check. Closed details omit content from
        // document.body.innerText (Death cause / xAI 502 mid-stream,
        // 2026-07-30 prune-latch-honesty L2).
        const res = await s.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return { ok: false, reason: 'not found' };
            const summary =
              el.tagName === 'SUMMARY'
                ? el
                : typeof el.closest === 'function'
                  ? el.closest('summary')
                  : null;
            const details =
              summary && typeof summary.closest === 'function'
                ? summary.closest('details')
                : null;
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            // Prefer reveal before click when already closed (open path).
            if (details) details.open = true;
            el.click();
            // Re-force after click: toggle would close an already-open panel.
            if (details) details.open = true;
            return { ok: true };
          })()`,
          returnByValue: true,
        });
        const val = (res['result'] as { value?: { ok?: boolean; reason?: string } } | undefined)
          ?.value;
        if (!val?.ok) {
          return {
            step,
            ok: false,
            detail: val?.reason ?? `click failed: ${sel}`,
          };
        }
        await sleep(ctx.settleMs);
        await s.send('Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center', inline: 'nearest' })`,
          returnByValue: true,
        });
        // Post-settle: SPA re-renders can leave a summary-targeted details
        // closed if a controlled open prop fought the DOM write. Uncontrolled
        // panels keep open=true; re-apply anyway so assert text= sees content.
        if (sel.includes('summary') || sel.includes('run-timeline')) {
          await s.send('Runtime.evaluate', {
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(sel)});
              if (!el) return;
              const summary =
                el.tagName === 'SUMMARY'
                  ? el
                  : typeof el.closest === 'function'
                    ? el.closest('summary')
                    : null;
              const details =
                summary && typeof summary.closest === 'function'
                  ? summary.closest('details')
                  : null;
              if (details) details.open = true;
            })()`,
            returnByValue: true,
          });
        }
        return { step, ok: true, detail: `clicked ${sel}` };
      }
      case 'assert': {
        // Poll — SPA data loads after boot; a single evaluate right after a
        // click catches "Loading…" frames and flakes the whole evidence run.
        const pollOpts = { timeoutMs: ASSERT_WAIT_MS, intervalMs: ASSERT_POLL_INTERVAL_MS };
        if (step.selector) {
          const ok = await pollAssert(async () => {
            const res = await s.send('Runtime.evaluate', {
              expression: `!!document.querySelector(${JSON.stringify(step.selector)})`,
              returnByValue: true,
            });
            return (res['result'] as { value?: boolean } | undefined)?.value === true;
          }, pollOpts);
          return {
            step,
            ok,
            detail: ok ? `found ${step.selector}` : `missing ${step.selector} after ${ASSERT_WAIT_MS}ms`,
          };
        }
        if (step.text) {
          const ok = await pollAssert(async () => {
            const res = await s.send('Runtime.evaluate', {
              expression: `document.body ? (document.body.innerText || '') : ''`,
              returnByValue: true,
            });
            return textMatches(
              String((res['result'] as { value?: string } | undefined)?.value ?? ''),
              step.text ?? '',
            );
          }, pollOpts);
          return {
            step,
            ok,
            detail: ok
              ? `text matched ${step.text.slice(0, 40)}`
              : `text not found after ${ASSERT_WAIT_MS}ms: ${step.text.slice(0, 40)}`,
          };
        }
        return { step, ok: false, detail: 'assert needs text= or sel=' };
      }
      case 'screenshot': {
        const path = ctx.nextShot();
        const shot = await s.send('Page.captureScreenshot', { format: 'png' });
        const data = shot['data'];
        if (typeof data !== 'string') {
          return { step, ok: false, detail: 'screenshot missing data' };
        }
        const bytes = Buffer.from(data, 'base64');
        writeFileSync(path, bytes);
        const base = path.split(/[/\\]/).pop() ?? path;
        const screenshotSha256 = createHash('sha256').update(bytes).digest('hex');
        return {
          step,
          ok: true,
          detail: `wrote ${base}`,
          screenshot: base,
          screenshotSha256,
        };
      }
      default:
        return { step, ok: false, detail: `unknown step kind` };
    }
  } catch (err) {
    return {
      step,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Support plain substring or /regex/i patterns. */
export function textMatches(haystack: string, pattern: string): boolean {
  const p = pattern.trim();
  if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
    const last = p.lastIndexOf('/');
    const body = p.slice(1, last);
    const flags = p.slice(last + 1) || 'i';
    try {
      return new RegExp(body, flags).test(haystack);
    } catch {
      return haystack.includes(p);
    }
  }
  // Pipe = alternation without full regex
  if (p.includes('|') && !p.startsWith('/')) {
    return p.split('|').some((part) => haystack.includes(part.trim()));
  }
  return haystack.includes(p);
}
