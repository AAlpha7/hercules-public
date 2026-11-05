import { describe, it, expect } from 'vitest';
import {
  adapterNeedsLocalWorkspace,
  adapterOwnsLocalProcess,
  isAdapterKind,
  isRemoteFactoryAdapter,
  isRemoteFactoryPrIdentity,
  resolveAdapterKind,
  resolveAdapterChain,
  ADAPTER_KINDS,
} from '../../src/domain/agents.js';

describe('isAdapterKind', () => {
  it('accepts known kinds', () => {
    for (const k of ADAPTER_KINDS) expect(isAdapterKind(k)).toBe(true);
  });
  it('rejects unknown', () => {
    expect(isAdapterKind('gpt')).toBe(false);
    expect(isAdapterKind('')).toBe(false);
  });
});

describe('resolveAdapterKind', () => {
  it('uses a valid override', () => {
    expect(resolveAdapterKind('codex', 'grok')).toBe('codex');
  });
  it('falls back to default when override is null/undefined', () => {
    expect(resolveAdapterKind(null, 'grok')).toBe('grok');
    expect(resolveAdapterKind(undefined, 'claude')).toBe('claude');
  });
  it('falls back when override is unknown', () => {
    expect(resolveAdapterKind('nope', 'fake')).toBe('fake');
  });
});

describe('adapterOwnsLocalProcess', () => {
  it('is true only for local CLI spawners', () => {
    expect(adapterOwnsLocalProcess('grok')).toBe(true);
    expect(adapterOwnsLocalProcess('codex')).toBe(true);
    expect(adapterOwnsLocalProcess('claude')).toBe(true);
    expect(adapterOwnsLocalProcess('cursor')).toBe(false);
    expect(adapterOwnsLocalProcess('fake')).toBe(false);
  });
});

describe('adapterNeedsLocalWorkspace', () => {
  it('is false only for the remote Cursor Cloud factory', () => {
    expect(adapterNeedsLocalWorkspace('grok')).toBe(true);
    expect(adapterNeedsLocalWorkspace('codex')).toBe(true);
    expect(adapterNeedsLocalWorkspace('claude')).toBe(true);
    expect(adapterNeedsLocalWorkspace('fake')).toBe(true);
    expect(adapterNeedsLocalWorkspace('cursor')).toBe(false);
  });
});

describe('isRemoteFactoryAdapter', () => {
  it('is true only for cursor', () => {
    expect(isRemoteFactoryAdapter('cursor')).toBe(true);
    expect(isRemoteFactoryAdapter('grok')).toBe(false);
    expect(isRemoteFactoryAdapter('codex')).toBe(false);
    expect(isRemoteFactoryAdapter('claude')).toBe(false);
    expect(isRemoteFactoryAdapter('fake')).toBe(false);
  });
});

describe('isRemoteFactoryPrIdentity', () => {
  it('follows task > repo and does not treat grok as factory', () => {
    expect(isRemoteFactoryPrIdentity({ taskAdapter: 'cursor', repoAdapter: 'grok' })).toBe(
      true,
    );
    expect(isRemoteFactoryPrIdentity({ taskAdapter: null, repoAdapter: 'cursor' })).toBe(
      true,
    );
    expect(isRemoteFactoryPrIdentity({ taskAdapter: 'grok', repoAdapter: 'cursor' })).toBe(
      false,
    );
    expect(isRemoteFactoryPrIdentity({ taskAdapter: null, repoAdapter: null })).toBe(false);
  });
});

describe('resolveAdapterChain (task > repo > daemon)', () => {
  it('prefers task over repo over default', () => {
    expect(
      resolveAdapterChain({ taskAdapter: 'claude', repoAdapter: 'codex', defaultKind: 'grok' }),
    ).toBe('claude');
  });
  it('uses repo when task is unset', () => {
    expect(
      resolveAdapterChain({ taskAdapter: null, repoAdapter: 'codex', defaultKind: 'grok' }),
    ).toBe('codex');
  });
  it('uses daemon default when both unset', () => {
    expect(
      resolveAdapterChain({ taskAdapter: null, repoAdapter: null, defaultKind: 'grok' }),
    ).toBe('grok');
  });
});
