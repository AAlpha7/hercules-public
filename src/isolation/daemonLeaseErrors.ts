/** Typed errors + util-linux flock constants (Guardian exclusive lease). */
import {
  formatDaemonLeaseIoDiagnostic,
  scopeFingerprint,
  type DaemonLeaseRecord,
} from '../domain/daemonLease.js';

export const FLOCK_BIN = '/usr/bin/flock';
export const FLOCK_HOLDER_BIN = '/usr/bin/cat';
/** util-linux flock -E exit code when -n cannot acquire. */
export const FLOCK_CONFLICT_EXIT = 73;

export type DaemonLeaseScopeKind = 'control' | 'work' | 'legacy';

/** Base typed error for daemon lease failures. */
export class DaemonLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonLeaseError';
  }
}

/** Extract Node errno code without reading Error.message (paths leak there). */
export function errnoCodeFrom(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return 'UNKNOWN';
}

/**
 * IO failure acquiring or releasing a lease (typed, fail-closed).
 * Message carries only operation, scope kind, path fingerprint, and errno.
 */
export class DaemonLeaseIOError extends DaemonLeaseError {
  readonly operation: string;
  readonly scopeKind: DaemonLeaseScopeKind;
  readonly fingerprint: string;
  readonly code: string;

  constructor(input: {
    readonly operation: string;
    readonly scopeKind: DaemonLeaseScopeKind;
    readonly path: string;
    readonly code?: string | null;
  }) {
    const code =
      typeof input.code === 'string' && input.code.length > 0
        ? input.code
        : 'UNKNOWN';
    const fingerprint = scopeFingerprint(input.path);
    super(
      formatDaemonLeaseIoDiagnostic({
        operation: input.operation,
        scopeKind: input.scopeKind,
        path: input.path,
        code,
      }),
    );
    this.name = 'DaemonLeaseIOError';
    this.operation = input.operation;
    this.scopeKind = input.scopeKind;
    this.fingerprint = fingerprint;
    this.code = code;
  }
}

/** Build a redacted lease IO error from a caught filesystem failure. */
export function daemonLeaseIoError(
  operation: string,
  scopeKind: DaemonLeaseScopeKind,
  path: string,
  err?: unknown,
): DaemonLeaseIOError {
  if (err === undefined) {
    return new DaemonLeaseIOError({ operation, scopeKind, path });
  }
  return new DaemonLeaseIOError({
    operation,
    scopeKind,
    path,
    code: errnoCodeFrom(err),
  });
}

/** Redacted console diagnostic for lease FS cleanup failures. */
export function logDaemonLeaseIo(
  operation: string,
  scopeKind: DaemonLeaseScopeKind,
  path: string,
  err: unknown,
): void {
  console.error(
    '[hercules] ' +
      formatDaemonLeaseIoDiagnostic({
        operation,
        scopeKind,
        path,
        code: errnoCodeFrom(err),
      }),
  );
}

/** Live foreign owner holds the lease; fail closed before mutation. */
export class DaemonLeaseConflictError extends DaemonLeaseError {
  readonly owner: DaemonLeaseRecord;
  readonly scopeKind: DaemonLeaseScopeKind;

  constructor(
    message: string,
    owner: DaemonLeaseRecord,
    scopeKind: DaemonLeaseScopeKind,
  ) {
    super(message);
    this.name = 'DaemonLeaseConflictError';
    this.owner = owner;
    this.scopeKind = scopeKind;
  }
}

/**
 * Held lease is no longer exclusive (unexpected flock death or intentional
 * release). Mutation gates must fail closed when this is thrown.
 */
export class DaemonLeaseLostError extends DaemonLeaseError {
  readonly reason: 'lost' | 'released';

  constructor(reason: 'lost' | 'released', message?: string) {
    super(
      message ??
        (reason === 'released'
          ? 'daemon lease already released'
          : 'daemon lease lost: flock holder exited unexpectedly'),
    );
    this.name = 'DaemonLeaseLostError';
    this.reason = reason;
  }
}

/** flock -n could not acquire (exit 73); claim layer may promote to conflict. */
export class FlockBusyError extends DaemonLeaseError {
  constructor() {
    super('flock busy: exclusive lock held by another process');
    this.name = 'FlockBusyError';
  }
}
