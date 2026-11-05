import { describe, it, expect } from 'vitest';
import { stampCancellationFields } from '../../src/domain/cancellationStamp.js';
import type { Task } from '../../src/domain/task.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T1',
    title: 'T1',
    repo: 'app',
    state: 'todo',
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
    body: '## Goal' + String.fromCharCode(10) + 'Do work',
    ...over,
  };
}

describe('stampCancellationFields', () => {
  it('stamps pre-session cancel without inventing a human actor id', () => {
    const stamped = stampCancellationFields(task(), 'cancel', {
      source: 'human_ui',
      at: '2026-08-04T18:00:00.000Z',
      hadActiveSession: false,
      correlationId: 'corr-pre',
      gitCommitAuthor: 'Hercules',
    });
    expect(stamped.body).toContain('## Cancellation audit');
    expect(stamped.body).toContain('pre_session');
    expect(stamped.body).toContain('human_ui');
    expect(stamped.body).not.toContain('Hercules');
    expect(stamped.source).toBe('human_ui');
  });
  it('stamps agent-running cancel with active session', () => {
    const stamped = stampCancellationFields(
      task({ state: 'in_progress', agentSession: 'sess-1' }),
      'cancel',
      {
        source: 'human_api',
        at: '2026-08-04T18:00:00.000Z',
        hadActiveSession: true,
        lifecyclePhase: 'agent_running',
      },
    );
    expect(stamped.body).toContain('agent_running');
    expect(stamped.body).toContain('Active session:** yes');
    expect(stamped.body).toContain('human_api');
    expect(stamped.source).toBe('human_api');
  });
  it('stamps daemon safety force-abort distinctly', () => {
    const stamped = stampCancellationFields(
      task({ state: 'in_progress', agentSession: 'sess-2' }),
      'force_abort',
      {
        source: 'daemon_safety',
        at: '2026-08-04T18:00:00.000Z',
        hadActiveSession: true,
        lifecyclePhase: 'stopping',
        message: 'Grace period expired; daemon forced SIGKILL.',
      },
    );
    expect(stamped.body).toContain('daemon_safety');
    expect(stamped.body).toContain('force_abort');
    expect(stamped.body).toContain('stopping');
    expect(stamped.source).toBe('daemon_safety');
  });
  it('leaves actor id unavailable when attribution is missing', () => {
    const stamped = stampCancellationFields(task(), 'cancel', {
      source: 'unknown',
      at: '2026-08-04T18:00:00.000Z',
      hadActiveSession: false,
    });
    expect(stamped.body).toContain('unavailable');
    expect(stamped.body).toContain('attribution_unavailable');
  });
});
