/**
 * Fake-adapter fault-injection scripts + isolation-only guard.
 */
import { describe, it, expect } from 'vitest';
import {
  FAKE_BEHAVIOR_SCRIPTS,
  fakeBehaviorToRunKnobs,
  isFakeBehaviorScript,
  isFakeFaultInjectionEnabled,
  parseFakeBehavior,
  resolveFakeBehaviorScript,
} from '../../src/domain/fakeBehavior.js';

describe('parseFakeBehavior (three scripts)', () => {
  it('accepts die-immediately | die-mid-turn | succeed', () => {
    expect(parseFakeBehavior('die-immediately')).toBe('die-immediately');
    expect(parseFakeBehavior('die-mid-turn')).toBe('die-mid-turn');
    expect(parseFakeBehavior('succeed')).toBe('succeed');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parseFakeBehavior('  Die-Immediately  ')).toBe('die-immediately');
    expect(parseFakeBehavior('DIE-MID-TURN')).toBe('die-mid-turn');
  });

  it('returns null for empty / unknown / non-string', () => {
    expect(parseFakeBehavior(null)).toBeNull();
    expect(parseFakeBehavior(undefined)).toBeNull();
    expect(parseFakeBehavior('')).toBeNull();
    expect(parseFakeBehavior('   ')).toBeNull();
    expect(parseFakeBehavior('explode')).toBeNull();
    expect(parseFakeBehavior(42)).toBeNull();
    expect(parseFakeBehavior({ die: true })).toBeNull();
  });

  it('FAKE_BEHAVIOR_SCRIPTS lists exactly the three states', () => {
    expect([...FAKE_BEHAVIOR_SCRIPTS].sort()).toEqual(
      ['die-immediately', 'die-mid-turn', 'succeed'].sort(),
    );
    expect(isFakeBehaviorScript('succeed')).toBe(true);
    expect(isFakeBehaviorScript('nope')).toBe(false);
  });
});

describe('isFakeFaultInjectionEnabled (isolation guard)', () => {
  it('is off by default (production / real adapters)', () => {
    expect(isFakeFaultInjectionEnabled({})).toBe(false);
    expect(isFakeFaultInjectionEnabled({ HERCULES_ADAPTER: 'grok' })).toBe(false);
    expect(isFakeFaultInjectionEnabled({ HERCULES_ADAPTER: 'claude' })).toBe(false);
    expect(
      isFakeFaultInjectionEnabled({
        HERCULES_ADAPTER: 'grok',
        HERCULES_FAKE_FAULT_INJECTION: '1',
      }),
    ).toBe(false);
  });

  it('requires both HERCULES_ADAPTER=fake and FAKE_FAULT_INJECTION on', () => {
    expect(
      isFakeFaultInjectionEnabled({
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
      }),
    ).toBe(true);
    expect(
      isFakeFaultInjectionEnabled({
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: 'true',
      }),
    ).toBe(true);
    expect(
      isFakeFaultInjectionEnabled({
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: 'on',
      }),
    ).toBe(true);
  });

  it('stays off for fake adapter without the isolation flag', () => {
    expect(isFakeFaultInjectionEnabled({ HERCULES_ADAPTER: 'fake' })).toBe(false);
    expect(
      isFakeFaultInjectionEnabled({
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '0',
      }),
    ).toBe(false);
    expect(
      isFakeFaultInjectionEnabled({
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: 'false',
      }),
    ).toBe(false);
  });
});

describe('resolveFakeBehaviorScript', () => {
  it('returns null when injection disabled even if script set', () => {
    expect(
      resolveFakeBehaviorScript({
        script: 'die-immediately',
        faultInjectionEnabled: false,
      }),
    ).toBeNull();
  });

  it('returns script when injection enabled', () => {
    expect(
      resolveFakeBehaviorScript({
        script: 'die-mid-turn',
        faultInjectionEnabled: true,
      }),
    ).toBe('die-mid-turn');
  });
});

describe('fakeBehaviorToRunKnobs', () => {
  it('die-immediately fails at t=0 with mid-stream 502 evidence', () => {
    const k = fakeBehaviorToRunKnobs('die-immediately');
    expect(k.durationMs).toBe(0);
    expect(k.fail).toBe(true);
    expect(k.stderrTail).toMatch(/502|mid-stream/i);
  });

  it('die-mid-turn runs briefly then fails with activity + stderr', () => {
    const k = fakeBehaviorToRunKnobs('die-mid-turn');
    expect(k.durationMs).toBeGreaterThan(0);
    expect(k.fail).toBe(true);
    expect(k.activity?.length).toBeGreaterThan(0);
    expect(k.stderrTail).toMatch(/502|stream/i);
  });

  it('succeed completes without fail', () => {
    const k = fakeBehaviorToRunKnobs('succeed');
    expect(k.fail).toBe(false);
    expect(k.durationMs).toBeGreaterThan(0);
  });
});
