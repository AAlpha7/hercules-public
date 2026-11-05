import { describe, it, expect } from 'vitest';
import { evidenceClickHints } from '../../src/verification/cdp.js';

describe('evidenceClickHints', () => {
  it('includes Settings/设置 for shell/chrome smoke flows', () => {
    const h = evidenceClickHints([
      'unlock with demo token and confirm the authenticated shell renders',
    ]);
    expect(h).toContain('Settings');
    expect(h).toContain('设置');
  });

  it('adds Chat when smoke mentions chat', () => {
    const h = evidenceClickHints(['open Chat and read messages']);
    expect(h).toContain('Chat');
  });
});
