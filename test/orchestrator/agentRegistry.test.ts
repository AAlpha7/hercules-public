import { describe, it, expect } from 'vitest';
import { AgentRegistry, AgentRegistryError } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import type { AgentAdapter, AgentRun, AgentStartInput, RunSnapshot } from '../../src/orchestrator/adapter.js';

function stub(name: string): AgentAdapter {
  const run: AgentRun = {
    sessionId: '',
    poll: (): RunSnapshot => ({ sessionId: '', status: 'done', lastEventAt: 0 }),
    activityLog: () => [],
    finalMessage: () => '',
    stop: () => undefined,
  };
  return {
    name,
    start: (_input: AgentStartInput, _now: number) => run,
  };
}

describe('AgentRegistry', () => {
  it('resolves the default when no override', () => {
    const grok = stub('grok');
    const reg = new AgentRegistry({ grok, fake: stub('fake') }, 'grok');
    expect(reg.resolve(null).kind).toBe('grok');
    expect(reg.resolve(null).adapter).toBe(grok);
  });

  it('honours a per-repo override', () => {
    const fake = stub('fake');
    const reg = new AgentRegistry({ grok: stub('grok'), fake }, 'grok');
    expect(reg.resolve('fake').kind).toBe('fake');
    expect(reg.resolve('fake').adapter).toBe(fake);
  });

  it('falls back when override is unregistered', () => {
    const grok = stub('grok');
    const reg = new AgentRegistry({ grok }, 'grok');
    expect(reg.resolve('codex').kind).toBe('grok');
  });

  it('cannot resolve unregistered claude (falls back to default)', () => {
    const grok = stub('grok');
    const reg = new AgentRegistry({ grok, codex: stub('codex'), fake: stub('fake') }, 'grok');
    expect(reg.has('claude')).toBe(false);
    expect(reg.available()).not.toContain('claude');
    expect(reg.resolve('claude').kind).toBe('grok');
  });

  it('lists available kinds in canonical order', () => {
    const reg = new AgentRegistry(
      { fake: stub('fake'), claude: stub('claude'), grok: stub('grok') },
      'grok',
    );
    expect(reg.available()).toEqual(['grok', 'claude', 'fake']);
  });

  it('rejects a default that is not registered', () => {
    expect(() => new AgentRegistry({ grok: stub('grok') }, 'codex')).toThrow(AgentRegistryError);
  });

  it('AgentRegistry.of wraps a single FakeAdapter', () => {
    const a = new FakeAdapter({ durationMs: 1 });
    const reg = AgentRegistry.of(a);
    expect(reg.defaultKind).toBe('fake');
    expect(reg.resolve(null).adapter).toBe(a);
  });
});
