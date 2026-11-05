/**
 * Composition-root ↔ adapter roster lockstep.
 *
 * With compatibility providers explicitly enabled, buildExecution registers
 * every known kind. Default selection still comes from HERCULES_ADAPTER.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildExecution } from '../../src/main.js';
import { ADAPTER_KINDS } from '../../src/domain/agents.js';

const KEYS = ['HERCULES_ADAPTER', 'HERCULES_WORK_DIR', 'HERCULES_CLAUDE_ENABLED'] as const;
const saved = new Map<string, string | undefined>();

function setAdapter(value: string | undefined): void {
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  if (value === undefined) delete process.env['HERCULES_ADAPTER'];
  else process.env['HERCULES_ADAPTER'] = value;
  delete process.env['HERCULES_CLAUDE_ENABLED'];
  process.env['HERCULES_WORK_DIR'] = '/tmp/hercules-roster-test';
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe('adapter roster invariant', () => {
  it('buildExecution registers every AdapterKind', () => {
    setAdapter('grok');
    process.env['HERCULES_CLAUDE_ENABLED'] = '1';
    const exec = buildExecution('/ctrl');
    expect([...exec.agents!.available()].sort()).toEqual([...ADAPTER_KINDS].sort());
  });

  it.each(['grok', 'codex', 'claude', 'cursor'] as const)(
    'buildExecution(%s) uses that kind as default on the real path',
    (name) => {
      setAdapter(name);
      if (name === 'claude') process.env['HERCULES_CLAUDE_ENABLED'] = '1';
      const exec = buildExecution('/ctrl');
      expect(exec.agents!.defaultKind).toBe(name);
      expect(exec.workspaces).toBeDefined();
      expect(exec.verifier).toBeDefined();
    },
  );

  it('default (unset) is grok on the real path', () => {
    setAdapter(undefined);
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('grok');
    expect(exec.workspaces).toBeDefined();
  });

  it('fake default without WORK_DIR stays a pure dry-run (no workspaces)', () => {
    for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
    process.env['HERCULES_ADAPTER'] = 'fake';
    delete process.env['HERCULES_WORK_DIR'];
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('fake');
    expect(exec.workspaces).toBeUndefined();
  });
});
