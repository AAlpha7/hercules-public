/**
 * Domain — bounded live verification observability (cancel + phone honesty).
 *
 * Verification is a first-class runtime phase after the agent exits. Metadata
 * exposed to API/UI must stay bounded and free of secrets / unbounded output.
 * Pure data + helpers only (no IO).
 */

/** High-level verification phases (gate ordering preserved by the runner). */
export const VERIFICATION_PHASES = [
  'setup',
  'l1',
  'held-out',
  'l2',
  'l3',
  'packet',
] as const;

export type VerificationPhase = (typeof VERIFICATION_PHASES)[number];

/**
 * Per-task live verification overlay (API / RuntimeView).
 * No command strings, env, tokens, or gate output tails.
 */
export interface VerificationRunMeta {
  readonly taskId: string;
  /** Current phase (setup / l1 / held-out / l2 / l3 / packet). */
  readonly phase: VerificationPhase;
  /** Current gate or sub-stage name (bounded, redacted). */
  readonly stage: string;
  /** ISO timestamp when this verification run began. */
  readonly startedAt: string;
  /** ms since verification began. */
  readonly elapsedMs: number;
  /** True while a gate/boot/browser child is believed alive. */
  readonly processAlive: boolean;
  /** Human cancel or force-abort requested for this verification. */
  readonly cancelRequested: boolean;
  /** Last fully completed stage name (or null at start). */
  readonly lastCompletedStage: string | null;
}

/** Progress event from the verifier → orchestrator (internal). */
export interface VerificationProgress {
  readonly phase: VerificationPhase;
  readonly stage: string;
  readonly processAlive?: boolean;
  readonly completedStage?: string;
}

/** Max stage/label length in public meta (prevents command dumps). */
export const VERIFICATION_STAGE_MAX_LEN = 64;

const SECRETISH =
  /(?:token|password|secret|api[_-]?key|authorization|bearer\s+\S+|HERCULES_[A-Z0-9_]*TOKEN)/i;

/**
 * Bound + scrub a stage label for public API/UI. Never pass full shell commands
 * with credentials; gate *names* (typecheck, test) are the intended input.
 */
export function redactVerificationStage(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return 'unknown';
  // Drop anything that looks like an env assignment or flag with a secret.
  if (SECRETISH.test(trimmed)) return 'redacted';
  // Never expose multi-line / shell-looking blobs as "stage".
  if (/[\n\r]/.test(raw) || trimmed.length > VERIFICATION_STAGE_MAX_LEN) {
    return trimmed.slice(0, VERIFICATION_STAGE_MAX_LEN);
  }
  // Strip obvious flag values that might carry tokens (--token=…).
  if (/--\w*(?:token|password|secret|key)=/i.test(trimmed)) return 'redacted';
  return trimmed;
}

export function isVerificationPhase(v: string): v is VerificationPhase {
  return (VERIFICATION_PHASES as readonly string[]).includes(v);
}

/** Build public meta from an in-memory verification handle. */
export function toVerificationRunMeta(input: {
  readonly taskId: string;
  readonly phase: VerificationPhase;
  readonly stage: string;
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly processAlive: boolean;
  readonly cancelRequested: boolean;
  readonly lastCompletedStage: string | null;
}): VerificationRunMeta {
  return {
    taskId: input.taskId,
    phase: input.phase,
    stage: redactVerificationStage(input.stage),
    startedAt: new Date(input.startedAtMs).toISOString(),
    elapsedMs: Math.max(0, input.nowMs - input.startedAtMs),
    processAlive: input.processAlive,
    cancelRequested: input.cancelRequested,
    lastCompletedStage:
      input.lastCompletedStage === null
        ? null
        : redactVerificationStage(input.lastCompletedStage),
  };
}

/**
 * Mutable abort reason shared as `AbortSignal.reason`.
 * Soft cancel starts with `force: false`; force-abort flips `force: true` so
 * in-flight TERM grace can escalate to immediate SIGKILL without re-aborting.
 */
export interface VerificationCancelReason {
  force: boolean;
  /** Internal coordinator cause; never serialized to the public runtime view. */
  cause?: 'human_cancel' | 'human_steer';
}

export function createVerificationCancelReason(
  force = false,
): VerificationCancelReason {
  return { force, cause: 'human_cancel' };
}

export function isHumanSteerVerificationCancel(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  return (reason as { cause?: unknown }).cause === 'human_steer';
}

export function isForceVerificationCancel(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  return (reason as { force?: unknown }).force === true;
}

/** Typed abort from cancelable verification (orchestrator must not re-queue). */
export class VerificationAbortedError extends Error {
  readonly code = 'verification_aborted' as const;
  readonly force: boolean;
  constructor(message = 'verification aborted by cancel', force = false) {
    super(message);
    this.name = 'VerificationAbortedError';
    this.force = force;
  }
}

/**
 * True when verification was cancelled/aborted (must not auto-rework).
 *
 * Recognizes {@link VerificationAbortedError}, AbortError (incl. DOMException
 * from fetch/AbortSignal), and structured `{ name, code }` clones. Order matters:
 * check AbortError / VerificationAbortedError by name before any "has a name →
 * return false" style short-circuit — DOMException always has a name.
 */
export function isVerificationAborted(err: unknown): boolean {
  if (err instanceof VerificationAbortedError) return true;
  if (err === null || err === undefined || typeof err !== 'object') return false;

  const o = err as { name?: unknown; code?: unknown; message?: unknown };

  // Prefer explicit abort names first (DOMException name=AbortError, Error name=…).
  // Never short-circuit "has a name property → false" — DOMException always has name.
  if (o.name === 'AbortError') return true;
  if (o.name === 'VerificationAbortedError') return true;

  // Typed code from VerificationAbortedError (and structured clones).
  if (o.code === 'verification_aborted') return true;

  return false;
}

/** Throw if the signal is already aborted (between gates / phases). */
export function throwIfVerificationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new VerificationAbortedError(
      'verification aborted by cancel',
      isForceVerificationCancel(signal.reason),
    );
  }
}
