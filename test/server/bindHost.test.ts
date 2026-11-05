/**
 * SPEC §10: the UI MUST NOT be exposed on the open internet. Today the server
 * binds all interfaces (0.0.0.0) and relies on a private network + the mandatory token.
 * resolveBindHost lets a locked-down deployment pin the listen address WITHOUT
 * changing the default — the live daemon is reached over a private network, so the
 * default MUST stay all-interfaces or remote access breaks.
 */
import { describe, it, expect } from 'vitest';
import { resolveBindHost } from '../../src/server/serve.js';

describe('resolveBindHost', () => {
  it('defaults to undefined (all interfaces) — preserves private-network access', () => {
    expect(resolveBindHost({})).toBeUndefined();
    expect(resolveBindHost({ HERCULES_BIND_HOST: '' })).toBeUndefined();
    expect(resolveBindHost({ HERCULES_BIND_HOST: '   ' })).toBeUndefined();
  });

  it('honors an explicit bind host for a locked-down deployment', () => {
    expect(resolveBindHost({ HERCULES_BIND_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(resolveBindHost({ HERCULES_BIND_HOST: '  192.0.2.10 ' })).toBe('192.0.2.10');
  });
});
