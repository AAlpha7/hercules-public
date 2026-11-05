import { describe, it, expect, vi } from 'vitest';
import { Reviewer } from '../../src/verification/reviewer.js';
import type { Task } from '../../src/domain/task.js';

const baseTask = {
  id: 'T',
  title: 't',
  repo: 'app',
  state: 'in_progress',
  priority: 1,
  blockedBy: [],
  labels: [],
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
  body: '## Goal\nship\n',
} as Task;

describe('Reviewer cancel signal', () => {
  it('forwards AbortSignal into the review runner', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const run = vi.fn(async (_prompt: string, opts?: { signal?: AbortSignal }) => {
      seen = opts?.signal;
      return 'VERDICT: approved\nSUMMARY: ok\n';
    });
    const reviewer = new Reviewer(run);
    await reviewer.review({
      task: baseTask,
      diff: '+x',
      cheatFindings: [],
      principles: '',
      signal: ac.signal,
    });
    expect(seen).toBe(ac.signal);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
