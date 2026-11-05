import { describe, it, expect } from 'vitest';
import { clipFragment, listFragment, FRAGMENT_BANNER } from '../../src/web/voiceFragments.js';

describe('voiceFragments', () => {
  it('stamps truncated text as FRAGMENT with counts', () => {
    const long = 'x'.repeat(100);
    const out = clipFragment(long, 20);
    expect(out).toContain(FRAGMENT_BANNER);
    expect(out).toMatch(/20 of 100/);
    expect(out.endsWith('…')).toBe(true);
  });

  it('forceFragment stamps short text', () => {
    const out = clipFragment('hello', 100, { forceFragment: true, note: 'preview only' });
    expect(out).toContain(FRAGMENT_BANNER);
    expect(out).toContain('preview only');
    expect(out).toContain('hello');
  });

  it('listFragment stamps when sliced', () => {
    const { text, truncated } = listFragment(['a', 'b', 'c', 'd'], 2, 'rows');
    expect(truncated).toBe(true);
    expect(text).toContain(FRAGMENT_BANNER);
    expect(text).toMatch(/2 of 4 rows/);
  });
});
