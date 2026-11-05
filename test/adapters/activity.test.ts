import { describe, it, expect } from 'vitest';
import { appendActivity, ACTIVITY_CAP } from '../../src/adapters/activity.js';

describe('appendActivity', () => {
  it('appends trimmed lines and ignores empty', () => {
    const b: string[] = [];
    appendActivity(b, '  hello  ');
    appendActivity(b, '   ');
    expect(b).toEqual(['hello']);
  });
  it('caps line length to 140 chars', () => {
    const b: string[] = [];
    appendActivity(b, 'x'.repeat(500));
    expect(b[0]!.length).toBe(140);
  });
  it('keeps only the last ACTIVITY_CAP lines', () => {
    const b: string[] = [];
    for (let i = 0; i < ACTIVITY_CAP + 10; i++) appendActivity(b, `line ${i}`);
    expect(b.length).toBe(ACTIVITY_CAP);
    expect(b[0]).toBe(`line 10`);
  });
});
