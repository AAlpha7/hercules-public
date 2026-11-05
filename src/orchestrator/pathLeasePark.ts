/**
 * Path-lease permanent-block parking helpers.
 *
 * Keeps the orchestrator tick loop free of CAS thrash when a permanent lease
 * defect (stale_base, protected_path_drift, etc.) must park to review.
 */

import { ControlMutationConflictError } from './gitControlPort.js';
import type { Task } from '../domain/task.js';

export const PATH_LEASE_BLOCKED_HEADING = '## Path lease blocked (pre-dispatch)';

/** True when a control mutation lost an optimistic concurrency race. */
export function isControlMutationContention(err: unknown): boolean {
  if (err instanceof ControlMutationConflictError) return true;
  if (
    err !== null &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name: unknown }).name === 'ControlMutationConflictError'
  ) {
    return true;
  }
  if (err instanceof Error) {
    return /changed before atomic mutation|dirty before atomic/i.test(err.message);
  }
  return false;
}

/** Build the durable park receipt body for a permanent path-lease block. */
export function buildPathLeaseBlockedBody(
  baseBody: string,
  input: {
    readonly message: string;
    readonly stamp: string;
    /** Empty string omits the re-plan sentence; undefined uses the default. */
    readonly footer?: string;
  },
): string {
  const footer =
    input.footer === undefined
      ? 'Fix the declaration or re-plan against the current base / protected paths.'
      : input.footer;
  const parkedLine =
    footer.length > 0
      ? '_Parked at ' +
        input.stamp +
        ' before any agent run. No adapter was started. ' +
        footer +
        '_'
      : '_Parked at ' +
        input.stamp +
        ' before any agent run. No adapter was started._';
  return (
    baseBody.trimEnd() +
    '\n\n' +
    PATH_LEASE_BLOCKED_HEADING +
    '\n\n' +
    input.message +
    '\n\n' +
    parkedLine +
    '\n'
  );
}

export type PermanentPathLeaseParkInput = {
  readonly reason: string;
  readonly detail: string;
  readonly message: string;
  readonly footer?: string;
};

export type PermanentPathLeaseParkDeps = {
  readonly taskId: string;
  readonly stamp: string;
  readonly shouldLog: (fingerprint: string) => boolean;
  readonly log: (line: string) => void;
  readonly tryTransition: (source: Task, body: string) => Promise<boolean>;
  readonly readTask: () => Promise<Task | undefined>;
};

/**
 * Park a permanent path-lease defect. Never throws on CAS contention: re-read
 * + retry once, else return deferred so the tick can continue with peers.
 */
export async function runPermanentPathLeasePark(
  task: Task,
  input: PermanentPathLeaseParkInput,
  deps: PermanentPathLeaseParkDeps,
): Promise<'parked' | 'deferred'> {
  const bodyFor = (baseBody: string): string =>
    buildPathLeaseBlockedBody(baseBody, {
      message: input.message,
      stamp: deps.stamp,
      ...(input.footer !== undefined ? { footer: input.footer } : {}),
    });

  const tryPark = async (source: Task): Promise<boolean> => {
    try {
      return await deps.tryTransition(source, bodyFor(source.body));
    } catch (err) {
      if (!isControlMutationContention(err)) throw err;
      const casFp =
        deps.taskId + '|path_lease_park_cas|' + input.reason + '|' + input.detail;
      if (deps.shouldLog(casFp)) {
        deps.log(
          '[hercules] ' +
            deps.taskId +
            ': path-lease park CAS contention — ' +
            (err as Error).message +
            '; re-read/retry',
        );
      }
      return false;
    }
  };

  let parked = await tryPark(task);
  if (!parked) {
    const fresh = await deps.readTask();
    if (!fresh) {
      parked = true;
    } else if (
      fresh.state === 'review' ||
      fresh.state === 'cancelled' ||
      fresh.state === 'deleted' ||
      fresh.state === 'done' ||
      fresh.state === 'failed'
    ) {
      parked = true;
    } else {
      parked = await tryPark(fresh);
    }
  }

  if (parked) return 'parked';

  const deferFp =
    deps.taskId + '|path_lease_park_deferred|' + input.reason + '|' + input.detail;
  if (deps.shouldLog(deferFp)) {
    deps.log(
      '[hercules] ' +
        deps.taskId +
        ': path-lease permanent block deferred (CAS); excluded this tick',
    );
  }
  return 'deferred';
}
