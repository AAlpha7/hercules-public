import { describe, it, expect } from 'vitest';
import {
  evaluateStall,
  resolveProcessAlive,
  parsePositiveMsEnv,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_MAX_RUN_MS,
} from '../../src/domain/stall.js';

/**
 * Activity sources (classified for stall policy):
 * 1. Adapter stream events → lastEventAt freshness
 * 2. Process liveness (agent child + optional OS probe) → processAlive
 * 3. Wall-clock run age → hard maxRunMs (never fully disable stall)
 */

describe('evaluateStall — silent-but-alive vs truly stuck', () => {
  const base = {
    nowMs: 0,
    lastEventAt: 0,
    startedAtMs: 0,
    stallTimeoutMs: 1_000,
    maxRunMs: 10_000,
  };

  it('continues when stream is fresh (adapter events)', () => {
    const d = evaluateStall({
      ...base,
      nowMs: 500,
      lastEventAt: 400,
      processAlive: false,
    });
    expect(d.action).toBe('continue');
    expect(d.silenceMs).toBe(100);
    expect(d.runMs).toBe(500);
  });

  it('idle-stalls when stream silent past timeout and process not alive', () => {
    // Truly stuck: no stream progress, no live process signal.
    const d = evaluateStall({
      ...base,
      nowMs: 1_500,
      lastEventAt: 0,
      processAlive: false,
    });
    expect(d.action).toBe('idle_stall');
    expect(d.silenceMs).toBe(1_500);
    expect(d.reason).toMatch(/stream idle/i);
    expect(d.reason).toMatch(/not reporting alive/i);
  });

  it('does not idle-stall when processAlive during long silent tools', () => {
    // Case study: cargo / pnpm test — zero stream events, child still running.
    const d = evaluateStall({
      ...base,
      nowMs: 5_000,
      lastEventAt: 0,
      processAlive: true,
    });
    expect(d.action).toBe('continue');
    expect(d.silenceMs).toBe(5_000);
    expect(d.reason).toMatch(/process alive/i);
  });

  it('hard-kills when maxRunMs exceeded even if processAlive', () => {
    // Deadlock backstop for free-tier box — stall is never fully disabled.
    const d = evaluateStall({
      ...base,
      nowMs: 12_000,
      lastEventAt: 0,
      processAlive: true,
      maxRunMs: 10_000,
    });
    expect(d.action).toBe('hard_max_run');
    expect(d.runMs).toBe(12_000);
    expect(d.reason).toMatch(/hard max run/i);
  });

  it('hard max wins over idle stall when both would fire', () => {
    const d = evaluateStall({
      ...base,
      nowMs: 12_000,
      lastEventAt: 0,
      processAlive: false,
      stallTimeoutMs: 1_000,
      maxRunMs: 10_000,
    });
    expect(d.action).toBe('hard_max_run');
  });

  it('continues under both limits with processAlive false if stream recent', () => {
    const d = evaluateStall({
      ...base,
      nowMs: 2_000,
      lastEventAt: 1_500, // silence 500 < stall 1000
      processAlive: false,
    });
    expect(d.action).toBe('continue');
  });

  it('uses default free-tier-sane timeouts in constants', () => {
    // 10m idle stream / 2h hard max — A1 12GB cargo can exceed 10m silence.
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(10 * 60_000);
    expect(DEFAULT_MAX_RUN_MS).toBe(2 * 60 * 60_000);
  });
});

describe('resolveProcessAlive', () => {
  it('trusts adapter processAlive when no OS probe', () => {
    expect(resolveProcessAlive({ processAlive: true })).toBe(true);
    expect(resolveProcessAlive({ processAlive: false })).toBe(false);
    expect(resolveProcessAlive({})).toBe(false);
  });

  it('OS dead overrides adapter alive (missed exit)', () => {
    expect(resolveProcessAlive({ processAlive: true, osAlive: false })).toBe(false);
  });

  it('OS alive can establish liveness without adapter flag', () => {
    // Defense: adapters that forget processAlive still skip idle-stall
    // when the child pid is live (and optionally has worker children).
    expect(resolveProcessAlive({ osAlive: true })).toBe(true);
    expect(resolveProcessAlive({ processAlive: false, osAlive: true })).toBe(true);
  });

  it('active children reinforce alive (long cargo under agent)', () => {
    expect(
      resolveProcessAlive({ processAlive: true, osAlive: true, hasActiveChildren: true }),
    ).toBe(true);
    // hasActiveChildren alone is not enough without process/os signal —
    // avoids treating a stale sample as forever-alive.
    expect(resolveProcessAlive({ hasActiveChildren: true })).toBe(false);
  });
});

describe('parsePositiveMsEnv', () => {
  it('returns fallback for missing/invalid', () => {
    expect(parsePositiveMsEnv(undefined, 1000)).toBe(1000);
    expect(parsePositiveMsEnv('', 1000)).toBe(1000);
    expect(parsePositiveMsEnv('0', 1000)).toBe(1000);
    expect(parsePositiveMsEnv('-5', 1000)).toBe(1000);
    expect(parsePositiveMsEnv('nope', 1000)).toBe(1000);
  });

  it('parses positive integers (floors floats)', () => {
    expect(parsePositiveMsEnv('1500', 1000)).toBe(1500);
    expect(parsePositiveMsEnv(' 7200000 ', 1000)).toBe(7_200_000);
    expect(parsePositiveMsEnv('100.9', 1000)).toBe(100);
  });
});
