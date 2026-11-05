/**
 * Unbounded fullText accumulation in the coding adapters OOM'd the daemon
 * (grok --resume replayed megabytes instantly after each crash → 4GB heap,
 * three SIGABRTs on 2026-07-18). All stream accumulators must be bounded.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boundedAppend,
  MAX_AGENT_TEXT,
  MAX_STDERR_TAIL,
} from '../../src/adapters/bounded.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('boundedAppend', () => {
  it('appends freely under the cap', () => {
    expect(boundedAppend('a', 'b', 10)).toBe('ab');
  });

  it('keeps the tail once over the hysteresis threshold, with a marker', () => {
    const out = boundedAppend('x'.repeat(100), 'y'.repeat(30), 100);
    expect(out.length).toBeLessThanOrEqual(100 + 60); // cap + marker slack
    expect(out).toMatch(/truncated/);
    expect(out.endsWith('y'.repeat(30))).toBe(true);
  });

  it('has a sane global cap', () => {
    expect(MAX_AGENT_TEXT).toBeGreaterThanOrEqual(1024 * 1024);
    expect(MAX_AGENT_TEXT).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('stderr death tail is ~2KB (no OOM risk)', () => {
    expect(MAX_STDERR_TAIL).toBe(2 * 1024);
    const huge = 'x'.repeat(10_000);
    const out = boundedAppend('', huge, MAX_STDERR_TAIL);
    expect(out.length).toBeLessThanOrEqual(MAX_STDERR_TAIL * 1.25 + 80);
    expect(out.endsWith('x'.repeat(100))).toBe(true);
  });
});

describe('adapters use bounded accumulation', () => {
  it('grok and codex fullText go through boundedAppend; line buffers are capped', async () => {
    for (const f of ['src/adapters/grok.ts', 'src/adapters/codex.ts']) {
      const src = await readFile(join(ROOT, f), 'utf8');
      expect(src, f).toMatch(/boundedAppend/);
      expect(src, f).toMatch(/MAX_STREAM_LINE_BUFFER|MAX_STDOUT_BUFFER/);
    }
    const claude = await readFile(join(ROOT, 'src/adapters/claude.ts'), 'utf8');
    expect(claude).toMatch(/MAX_STREAM_LINE_BUFFER|MAX_STDOUT_BUFFER/);
  });

  it('coding adapters capture stderr via MAX_STDERR_TAIL', async () => {
    for (const f of [
      'src/adapters/grok.ts',
      'src/adapters/codex.ts',
      'src/adapters/claude.ts',
    ]) {
      const src = await readFile(join(ROOT, f), 'utf8');
      expect(src, f).toMatch(/MAX_STDERR_TAIL/);
      expect(src, f).toMatch(/stderrTail/);
    }
  });
});
