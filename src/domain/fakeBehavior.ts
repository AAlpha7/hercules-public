/**
 * Domain — fake-adapter fault-injection scripts for L2 isolation.
 *
 * Resilience (failover / death cause) only appears under failure. Unit tests
 * alone cannot produce phone-visible L2 screenshots. Controlled scripts let the
 * isolation fake adapter die (or succeed) so timeline 降级 notes and death-cause
 * mini-packets become assertable evidence.
 *
 * Safety: scripts never fire outside fake + explicit isolation enablement.
 * Real adapters ignore {@link Task.fakeBehavior} entirely.
 */

/** Controlled die/succeed scripts (task front matter `fake_behavior:`). */
export const FAKE_BEHAVIOR_SCRIPTS = [
  'die-immediately',
  'die-mid-turn',
  'succeed',
] as const;

export type FakeBehaviorScript = (typeof FAKE_BEHAVIOR_SCRIPTS)[number];

export function isFakeBehaviorScript(value: unknown): value is FakeBehaviorScript {
  return (
    typeof value === 'string' &&
    (FAKE_BEHAVIOR_SCRIPTS as readonly string[]).includes(value.trim())
  );
}

/**
 * Parse task front-matter / start-input value.
 * Unknown / empty → null (no script; adapter default behavior).
 */
export function parseFakeBehavior(raw: unknown): FakeBehaviorScript | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0) return null;
  if (isFakeBehaviorScript(v)) return v;
  return null;
}

/**
 * Isolation-only fault injection.
 *
 * Requires **both**:
 * 1. `HERCULES_ADAPTER=fake` (never on a real provider default)
 * 2. `HERCULES_FAKE_FAULT_INJECTION=1` (or true/on/yes) — L2 WORKFLOW boot sets this
 *
 * Production / dry-run fake without the explicit flag ignores `fake_behavior`.
 */
export function isFakeFaultInjectionEnabled(
  env: Readonly<Record<string, string | undefined>> = {},
): boolean {
  const adapter = (env['HERCULES_ADAPTER'] ?? 'grok').trim().toLowerCase();
  if (adapter !== 'fake') return false;
  const raw = (env['HERCULES_FAKE_FAULT_INJECTION'] ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/**
 * Resolve the script the fake adapter should honor for this start.
 * Returns null when injection is disabled or no script is set.
 */
export function resolveFakeBehaviorScript(input: {
  readonly script: FakeBehaviorScript | null | undefined;
  readonly faultInjectionEnabled: boolean;
}): FakeBehaviorScript | null {
  if (!input.faultInjectionEnabled) return null;
  return input.script ?? null;
}

/** Run knobs derived from a script (FakeAdapter maps these onto FakeBehavior). */
export interface FakeBehaviorRunKnobs {
  readonly durationMs: number;
  readonly fail: boolean;
  readonly activity?: readonly string[];
  readonly stderrTail?: string;
}

/**
 * Map a script onto FakeAdapter duration/fail/stderr knobs.
 * Pure so unit tests can assert without constructing the adapter.
 */
export function fakeBehaviorToRunKnobs(script: FakeBehaviorScript): FakeBehaviorRunKnobs {
  switch (script) {
    case 'die-immediately':
      return {
        durationMs: 0,
        fail: true,
        stderrTail:
          'error: status 502 Bad Gateway mid-stream while streaming response',
      };
    case 'die-mid-turn':
      return {
        durationMs: 80,
        fail: true,
        activity: [
          'fake: mid-turn tool call',
          'fake: streaming assistant tokens…',
          'error: stream interrupted status 502 Bad Gateway mid-stream',
        ],
        stderrTail: 'status 502 Bad Gateway mid-stream (provider disconnect)',
      };
    case 'succeed':
      return {
        durationMs: 50,
        fail: false,
        activity: ['fake: fault-injection succeed script'],
      };
  }
}
