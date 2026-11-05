import { describe, it, expect } from 'vitest';
import { humanizeNetworkError } from '../../src/web/api.js';

describe('humanizeNetworkError', () => {
  it('maps Safari Load failed and Chrome Failed to fetch', () => {
    expect(humanizeNetworkError(new TypeError('Load failed'))).toMatch(/Network error/);
    expect(humanizeNetworkError(new TypeError('Failed to fetch'))).toMatch(/Network error/);
  });

  it('maps AbortError', () => {
    expect(humanizeNetworkError(new DOMException('aborted', 'AbortError'))).toMatch(/cancelled/i);
  });

  it('passes through other messages', () => {
    expect(humanizeNetworkError(new Error('unauthorized'))).toBe('unauthorized');
  });
});
