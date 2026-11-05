/**
 * C3.60: two different tasks crashing the same adapter process (signal deaths)
 * hold that adapter instead of burning the queue one attempt at a time.
 */
import { describe, it, expect } from 'vitest';
import {
  ADAPTER_CRASH_HOLD_MS,
  ADAPTER_CRASH_WINDOW_MS,
  adapterCrashHold,
  adapterCrashHolds,
  isSignalExitCode,
  recordAdapterCrash,
  type AdapterCrashState,
} from '../../src/domain/adapterHealth.js';

const T0 = 1_700_000_000_000;

function crash(
  state: AdapterCrashState,
  taskId: string,
  atMs: number,
  exitCode = 132,
): AdapterCrashState {
  return recordAdapterCrash(state, { adapter: 'grok', taskId, exitCode, atMs });
}

describe('adapter crash breaker', () => {
  it('classifies only signal exits as crashes', () => {
    expect(isSignalExitCode(132)).toBe(true);
    expect(isSignalExitCode(137)).toBe(true);
    expect(isSignalExitCode(1)).toBe(false);
    expect(isSignalExitCode(128)).toBe(false);
    expect(isSignalExitCode(null)).toBe(false);
    expect(isSignalExitCode(undefined)).toBe(false);
  });

  it('opens only after two DIFFERENT tasks crash, and names the signal', () => {
    let state = crash(new Map(), 'task-a', T0);
    expect(adapterCrashHold(state, 'grok', T0)).toBeNull();
    // The same task crashing twice is thrash, not an adapter verdict.
    state = crash(state, 'task-a', T0 + 1_000);
    expect(adapterCrashHold(state, 'grok', T0 + 1_000)).toBeNull();
    state = crash(state, 'task-b', T0 + 2_000);
    const hold = adapterCrashHold(state, 'grok', T0 + 2_000);
    expect(hold).not.toBeNull();
    expect(hold!.detail).toMatch(/SIGILL/);
    expect(hold!.detail).toMatch(/grok/);
    expect(hold!.untilMs).toBe(T0 + 2_000 + ADAPTER_CRASH_HOLD_MS);
  });

  it('ignores ordinary task failures and other adapters', () => {
    let state = crash(new Map(), 'task-a', T0, 1);
    state = crash(state, 'task-b', T0 + 1_000, 1);
    expect(adapterCrashHold(state, 'grok', T0 + 1_000)).toBeNull();
    state = recordAdapterCrash(state, { adapter: 'codex', taskId: 'task-c', exitCode: 139, atMs: T0 });
    state = recordAdapterCrash(state, { adapter: 'codex', taskId: 'task-d', exitCode: 139, atMs: T0 });
    expect(adapterCrashHold(state, 'grok', T0)).toBeNull();
    expect(adapterCrashHold(state, 'codex', T0)).not.toBeNull();
    expect([...adapterCrashHolds(state, T0).keys()]).toEqual(['codex']);
  });

  it('forgets crashes older than the window and expires the hold', () => {
    let state = crash(new Map(), 'task-a', T0);
    state = crash(state, 'task-b', T0 + ADAPTER_CRASH_WINDOW_MS + 1);
    // task-a fell out of the window: one distinct task left, no hold.
    expect(adapterCrashHold(state, 'grok', T0 + ADAPTER_CRASH_WINDOW_MS + 1)).toBeNull();
    // Two fresh crashes hold, then the hold lapses on its own.
    state = crash(state, 'task-c', T0 + ADAPTER_CRASH_WINDOW_MS + 2);
    const at = T0 + ADAPTER_CRASH_WINDOW_MS + 2;
    expect(adapterCrashHold(state, 'grok', at)).not.toBeNull();
    expect(adapterCrashHold(state, 'grok', at + ADAPTER_CRASH_HOLD_MS)).toBeNull();
    expect(adapterCrashHolds(state, at + ADAPTER_CRASH_HOLD_MS).size).toBe(0);
  });
});
