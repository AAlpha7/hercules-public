/**
 * Evidence assert steps must WAIT (poll) — a screenshot/assert taken right
 * after boot caught "Waiting for the first tick…" and Releases "Loading…"
 * (2026-07-18 staging evidence), because assert evaluated exactly once.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollAssert } from '../../src/verification/evidenceDrive.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('pollAssert', () => {
  it('resolves true once the condition holds within the budget', async () => {
    let calls = 0;
    const ok = await pollAssert(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      { timeoutMs: 2000, intervalMs: 10 },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up false after the timeout', async () => {
    const ok = await pollAssert(async () => false, { timeoutMs: 60, intervalMs: 10 });
    expect(ok).toBe(false);
  });

  it('assert steps go through pollAssert (selector and text)', async () => {
    const src = await readFile(join(ROOT, 'src/verification/evidenceDrive.ts'), 'utf8');
    const assertCase = src.slice(src.indexOf("case 'assert'"), src.indexOf("case 'screenshot'"));
    expect(assertCase).toMatch(/pollAssert/);
  });

  /**
   * L2 click on an open <details><summary> must not leave the section closed.
   * Native summary clicks toggle; assert text= uses document.body.innerText,
   * which omits closed-details content (2026-07-30: agent-death-cause found
   * but Death cause|xAI 502|mid-stream missing after timeline toggle-close).
   */
  it('click on summary always forces parent details open (reveal, not toggle)', async () => {
    const src = await readFile(join(ROOT, 'src/verification/evidenceDrive.ts'), 'utf8');
    const clickCase = src.slice(src.indexOf("case 'click'"), src.indexOf("case 'assert'"));
    expect(clickCase).toMatch(/closest\(['"]summary['"]\)/);
    expect(clickCase).toMatch(/closest\(['"]details['"]\)/);
    // Unconditional force — not only `if (!details.open)` (race with deferred toggle).
    expect(clickCase).toMatch(/if \(details\) details\.open = true/);
    expect(clickCase).not.toMatch(/if \(details && !details\.open\)/);
    // Force before click (open path) and again after (undo toggle-close).
    const firstForce = clickCase.indexOf('if (details) details.open = true');
    const clickAt = clickCase.indexOf('el.click()');
    const secondForce = clickCase.indexOf('if (details) details.open = true', firstForce + 1);
    expect(firstForce).toBeGreaterThanOrEqual(0);
    expect(clickAt).toBeGreaterThan(firstForce);
    expect(secondForce).toBeGreaterThan(clickAt);
    // Post-settle re-open for summary / run-timeline targets.
    expect(clickCase).toMatch(/Post-settle|post-settle|run-timeline/);
    expect(clickCase).toMatch(/settleMs/);
  });

  it('keeps the clicked evidence target in the captured viewport', async () => {
    const src = await readFile(join(ROOT, 'src/verification/evidenceDrive.ts'), 'utf8');
    const clickCase = src.slice(src.indexOf("case 'click'"), src.indexOf("case 'assert'"));
    const clicks = [...clickCase.matchAll(/scrollIntoView\(\{ block: 'center'/g)];
    expect(clicks).toHaveLength(2);
    expect(clickCase.indexOf('scrollIntoView')).toBeLessThan(clickCase.indexOf('el.click()'));
    expect(clickCase.lastIndexOf('scrollIntoView')).toBeGreaterThan(clickCase.indexOf('settleMs'));
  });
});
