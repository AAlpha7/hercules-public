import { describe, it, expect } from 'vitest';
import { parseTaskFile, serializeTask } from '../../src/control/taskFile.js';
import type { Task } from '../../src/domain/task.js';

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T-CLOSE',
    title: 'closure stamp',
    repo: 'app',
    state: 'done',
    priority: 100,
    blockedBy: [],
    labels: ['onboarding'],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 1,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    body: '## Task\n\nwork\n',
    ...over,
  };
}

describe('taskFile project-state closure fields', () => {
  it('round-trips status + digest (restart survival)', () => {
    const task = baseTask({
      projectStateClosureStatus: 'passed',
      projectStateClosureDigest:
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    });
    const raw = serializeTask(task);
    expect(raw).toContain('project_state_closure_status: passed');
    expect(raw).toContain('project_state_closure_digest:');
    const parsed = parseTaskFile(raw, 'T-CLOSE');
    expect(parsed.projectStateClosureStatus).toBe('passed');
    expect(parsed.projectStateClosureDigest).toBe(
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    );
  });

  it('omits fields on ordinary tasks (no global churn)', () => {
    const raw = serializeTask(baseTask());
    expect(raw).not.toContain('project_state_closure');
    const parsed = parseTaskFile(raw, 'T-CLOSE');
    expect(parsed.projectStateClosureStatus).toBeUndefined();
    expect(parsed.projectStateClosureDigest).toBeUndefined();
  });
});
