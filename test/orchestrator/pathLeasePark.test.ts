import { describe, expect, it } from 'vitest';
import {
  buildPathLeaseBlockedBody,
  isControlMutationContention,
  PATH_LEASE_BLOCKED_HEADING,
  runPermanentPathLeasePark,
} from '../../src/orchestrator/pathLeasePark.js';
import { ControlMutationConflictError } from '../../src/orchestrator/gitControlPort.js';
import type { Task, TaskState } from '../../src/domain/task.js';

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T',
    title: 'T',
    repo: 'app',
    state: 'todo' as TaskState,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: 'body',
    ...over,
  };
}

describe('pathLeasePark helpers', () => {
  it('detects ControlMutationConflictError and message-shaped contention', () => {
    expect(
      isControlMutationContention(
        new ControlMutationConflictError('task changed before atomic mutation'),
      ),
    ).toBe(true);
    expect(
      isControlMutationContention(new Error('control repo is dirty before atomic mutation')),
    ).toBe(true);
    expect(isControlMutationContention(new Error('clone failed'))).toBe(false);
    expect(isControlMutationContention(null)).toBe(false);
  });

  it('builds a durable path-lease blocked receipt', () => {
    const body = buildPathLeaseBlockedBody('task body', {
      message: 'Stale base: tip moved',
      stamp: '2026-08-06T00:00:00.000Z',
    });
    expect(body).toContain('task body');
    expect(body).toContain(PATH_LEASE_BLOCKED_HEADING);
    expect(body).toContain('Stale base: tip moved');
    expect(body).toContain('2026-08-06T00:00:00.000Z');
    expect(body).toContain('No adapter was started');
  });

  it('retries park once after CAS then parks', async () => {
    let attempts = 0;
    const task = baseTask();
    const outcome = await runPermanentPathLeasePark(
      task,
      { reason: 'stale_base', detail: 'tip moved', message: 'Stale base' },
      {
        taskId: task.id,
        stamp: '2026-08-06T00:00:00.000Z',
        shouldLog: () => true,
        log: () => {},
        tryTransition: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ControlMutationConflictError('task changed before atomic mutation');
          }
          return true;
        },
        readTask: async () => task,
      },
    );
    expect(outcome).toBe('parked');
    expect(attempts).toBe(2);
  });

  it('defers without throwing when CAS keeps failing', async () => {
    const task = baseTask();
    const outcome = await runPermanentPathLeasePark(
      task,
      { reason: 'stale_base', detail: 'tip moved', message: 'Stale base' },
      {
        taskId: task.id,
        stamp: '2026-08-06T00:00:00.000Z',
        shouldLog: () => true,
        log: () => {},
        tryTransition: async () => {
          throw new ControlMutationConflictError('task changed before atomic mutation');
        },
        readTask: async () => task,
      },
    );
    expect(outcome).toBe('deferred');
  });

  it('treats already-review as parked after CAS', async () => {
    const task = baseTask();
    const outcome = await runPermanentPathLeasePark(
      task,
      { reason: 'stale_base', detail: 'tip moved', message: 'Stale base' },
      {
        taskId: task.id,
        stamp: '2026-08-06T00:00:00.000Z',
        shouldLog: () => true,
        log: () => {},
        tryTransition: async () => {
          throw new ControlMutationConflictError('task changed before atomic mutation');
        },
        readTask: async () => baseTask({ state: 'review' }),
      },
    );
    expect(outcome).toBe('parked');
  });
});
