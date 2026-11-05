/**
 * reverify must surface WorkspaceError (e.g. exact task-branch lease mismatch)
 * as ActionConflictError → HTTP 409, not a bare 500.
 */
import { describe, it, expect } from 'vitest';
import {
  ActionService,
  ActionConflictError,
} from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { WorkspaceError } from '../../src/isolation/worktree.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't-reverify',
    title: 'Reverify target',
    repo: 'app',
    state: 'review',
    priority: 1,
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
    body: '',
    ...over,
  };
}

class FakePort implements ControlPort {
  constructor(readonly tasks: Map<string, Task>) {}
  readonly repos: ReposConfig = {
    repos: {
      app: {
        key: 'app',
        url: 'https://example.com/app.git',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: null,
        readiness: 'ready',
      },
    },
  };
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return {
      repos: this.repos,
      tasks: [...this.tasks.values()],
      problems: [],
    };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

const probe: RepoProbe = {
  async probe() {
    return { branches: ['main'] };
  },
};

describe('ActionService.reverify WorkspaceError → conflict', () => {
  it('maps WorkspaceError from workspaces.create to ActionConflictError', async () => {
    const t = task();
    const port = new FakePort(new Map([[t.id, t]]));
    const actions = new ActionService(
      port,
      probe,
      undefined,
      undefined,
      {
        workspaces: {
          async create() {
            throw new WorkspaceError(
              'task branch exact lease changed before dispatch (expected aaaa, actual bbbb)',
            );
          },
          async preserve() {
            return undefined;
          },
        },
        verifier: {
          async verify() {
            throw new Error('verifier should not run');
          },
        },
      },
    );

    await expect(actions.reverify(t.id)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ActionConflictError);
      expect((err as Error).message).toContain('exact lease changed');
      return true;
    });
  });

  it('propagates non-WorkspaceError from workspaces.create unchanged', async () => {
    const t = task({ id: 't-boom' });
    const port = new FakePort(new Map([[t.id, t]]));
    const boom = new Error('boom');
    const actions = new ActionService(
      port,
      probe,
      undefined,
      undefined,
      {
        workspaces: {
          async create() {
            throw boom;
          },
          async preserve() {
            return undefined;
          },
        },
        verifier: {
          async verify() {
            throw new Error('verifier should not run');
          },
        },
      },
    );

    await expect(actions.reverify(t.id)).rejects.toBe(boom);
  });
});
