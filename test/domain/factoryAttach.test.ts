import { describe, expect, it } from 'vitest';
import { factoryAttachAgentId, isSafeFactoryAgentId } from '../../src/domain/factoryAttach.js';

describe('isSafeFactoryAgentId', () => {
  it('accepts Cursor Cloud ids', () => {
    expect(isSafeFactoryAgentId('bc_1')).toBe(true);
    expect(isSafeFactoryAgentId('bc_live-factory.1')).toBe(true);
  });

  it('rejects empty, traversal, and oversized ids', () => {
    expect(isSafeFactoryAgentId('')).toBe(false);
    expect(isSafeFactoryAgentId('..')).toBe(false);
    expect(isSafeFactoryAgentId('../bc_1')).toBe(false);
    expect(isSafeFactoryAgentId('bc_1/../x')).toBe(false);
    expect(isSafeFactoryAgentId('a'.repeat(129))).toBe(false);
  });
});

describe('factoryAttachAgentId', () => {
  it('returns the stored Cloud Agent id for a factory task', () => {
    expect(
      factoryAttachAgentId({
        adapter: 'cursor',
        agentSessionAdapter: 'cursor',
        agentSession: 'bc_live',
        pendingSteer: null,
      }),
    ).toBe('bc_live');
  });

  it('is silent for local CLI, missing ids, and pending steer', () => {
    expect(
      factoryAttachAgentId({
        adapter: 'grok',
        agentSessionAdapter: 'grok',
        agentSession: 'sess-1',
        pendingSteer: null,
      }),
    ).toBeNull();
    expect(
      factoryAttachAgentId({
        adapter: 'cursor',
        agentSessionAdapter: 'cursor',
        agentSession: null,
        pendingSteer: null,
      }),
    ).toBeNull();
    expect(
      factoryAttachAgentId({
        adapter: 'cursor',
        agentSessionAdapter: 'cursor',
        agentSession: 'bc_live',
        pendingSteer: 'fix CI on the existing PR',
      }),
    ).toBeNull();
  });
});
