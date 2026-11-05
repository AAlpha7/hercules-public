/**
 * C3.60 — adapter crash circuit breaker.
 *
 * A signal death (exit 128 + N) is the adapter *process* crashing, not a task
 * problem: nothing the task or its branch can change will help, and every
 * dispatch burns an attempt and parks another task for thrash. On 2026-09-14
 * the grok CLI auto-updated itself to a build that died with SIGILL on every
 * headless run (`grok --version` still worked, stdout and stderr were empty),
 * and two a downstream project tasks were consumed one after another before a human
 * noticed the pattern.
 *
 * When two DIFFERENT tasks die of a signal on the same adapter inside a short
 * window, that adapter stops dispatching until the hold expires; the hold
 * detail names the signal so the operator looks at the binary. Per-process
 * state only: a daemon restart re-probes reality by trying again.
 */
import type { AdapterKind } from './agents.js';
import { agentDeathSignalName } from './agentDeath.js';

/** Two distinct tasks crashing this far apart still count as one pattern. */
export const ADAPTER_CRASH_WINDOW_MS = 30 * 60_000;
/** How long the adapter stops dispatching after the breaker opens. */
export const ADAPTER_CRASH_HOLD_MS = 30 * 60_000;
/** Distinct crashed tasks required to open the breaker. */
export const ADAPTER_CRASH_TASK_THRESHOLD = 2;

export interface AdapterCrash {
  readonly taskId: string;
  readonly atMs: number;
  readonly exitCode: number;
  readonly signal: string;
}

/** Per-adapter crash history (bounded, in-process). */
export type AdapterCrashState = ReadonlyMap<AdapterKind, readonly AdapterCrash[]>;

export interface AdapterCrashHold {
  readonly untilMs: number;
  readonly detail: string;
}

/** True when an exit code is a shell's 128 + N signal death. */
export function isSignalExitCode(exitCode: number | null | undefined): boolean {
  return exitCode !== null && exitCode !== undefined && agentDeathSignalName(exitCode) !== null;
}

/**
 * Record one agent death. Non-signal exits are ignored (they are ordinary task
 * failures). Keeps only crashes inside the window, newest last.
 */
export function recordAdapterCrash(
  state: AdapterCrashState,
  input: {
    readonly adapter: AdapterKind;
    readonly taskId: string;
    readonly exitCode: number | null | undefined;
    readonly atMs: number;
  },
): AdapterCrashState {
  const signal = input.exitCode === null || input.exitCode === undefined
    ? null
    : agentDeathSignalName(input.exitCode);
  if (signal === null) return state;
  const next = new Map(state);
  const kept = (next.get(input.adapter) ?? []).filter(
    (crash) => input.atMs - crash.atMs <= ADAPTER_CRASH_WINDOW_MS && crash.taskId !== input.taskId,
  );
  next.set(input.adapter, [
    ...kept.slice(-ADAPTER_CRASH_TASK_THRESHOLD * 4),
    { taskId: input.taskId, atMs: input.atMs, exitCode: input.exitCode as number, signal },
  ]);
  return next;
}

/** Open hold for an adapter, or null when it is healthy / the hold expired. */
export function adapterCrashHold(
  state: AdapterCrashState,
  adapter: AdapterKind,
  nowMs: number,
): AdapterCrashHold | null {
  const crashes = (state.get(adapter) ?? []).filter(
    (crash) => nowMs - crash.atMs <= ADAPTER_CRASH_WINDOW_MS,
  );
  const distinct = new Set(crashes.map((crash) => crash.taskId));
  if (distinct.size < ADAPTER_CRASH_TASK_THRESHOLD) return null;
  const last = crashes[crashes.length - 1]!;
  const untilMs = last.atMs + ADAPTER_CRASH_HOLD_MS;
  if (untilMs <= nowMs) return null;
  const signals = [...new Set(crashes.map((crash) => crash.signal))].sort().join('/');
  return {
    untilMs,
    detail:
      `${distinct.size} tasks crashed the \`${adapter}\` adapter process ` +
      `(${signals}) within ${Math.round(ADAPTER_CRASH_WINDOW_MS / 60_000)} min — ` +
      'the adapter binary or its runtime is broken (it may have auto-updated); ' +
      'task dispatch for this adapter is held, no attempts are burned',
  };
}

/** Adapter holds for every adapter currently tripped (scheduling input). */
export function adapterCrashHolds(
  state: AdapterCrashState,
  nowMs: number,
): ReadonlyMap<AdapterKind, AdapterCrashHold> {
  const out = new Map<AdapterKind, AdapterCrashHold>();
  for (const adapter of state.keys()) {
    const hold = adapterCrashHold(state, adapter, nowMs);
    if (hold !== null) out.set(adapter, hold);
  }
  return out;
}
